import { execFile } from 'node:child_process';

import type { AlertState, StatsPayload } from '../shared/contract.js';
import { allowedTargets, controlOf } from './actions.js';
import { ChatError } from './chatAdapter.js';
import { redact } from './chatOpencode.js';
import { humanBytes } from './collect/memory.js';
import { listUnits, readLogs } from './logs.js';

/**
 * Text about this host that the chat can put in a message: a metrics snapshot,
 * a service's logs, the alerts firing, what is eating the disk. The browser
 * drops it into the message box, where the person reads it and edits it before
 * sending, so nothing reaches the agent that they did not see. Every line goes
 * through redact(), like the agent's own output. Read-only: journalctl,
 * `systemctl show`, `docker logs` and `docker system df` run with fixed
 * arguments and a unit or container name checked against what Pulse knows.
 */

export interface ContextSources {
  readonly stats: () => Promise<StatsPayload>;
  readonly alerts: () => AlertState;
}

export interface ChatContext {
  readonly title: string;
  readonly text: string;
}

const LINE_MAX = 300;
const LOG_LINES_MAX = 200;
const LOG_CHARS = 7_000;
const CMD_TIMEOUT_MS = 6_000;
const CMD_BYTES = 256 * 1024;

const pct = (n: number): string => `${Math.round(n)}%`;
const clip = (s: string, n = LINE_MAX): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: CMD_TIMEOUT_MS, maxBuffer: CMD_BYTES, windowsHide: true, ...(env ? { env } : {}) }, (_err, stdout, stderr) => {
      // `docker logs` writes the container's stderr to ours: both are the log.
      resolve(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim());
    });
  });
}

function uptimeText(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function metricsText(p: StatsPayload): string {
  const s = p.system;
  const m = s.memory;
  const lines = [
    `host ${s.hostname}, up ${uptimeText(s.uptime)}, kernel ${s.kernel}`,
    `CPU ${pct(s.cpu.usage)} of ${s.cpu.cores} cores, load ${s.cpu.load1m} ${s.cpu.load5m} ${s.cpu.load15m} (1m 5m 15m)`,
    `RAM ${pct(m.percent)} in use (${humanBytes(m.usedBytes)} of ${humanBytes(m.totalBytes)}), ${humanBytes(m.availableBytes)} available, ${humanBytes(m.cachedBytes ?? 0)} of it reclaimable cache`,
    `swap ${humanBytes(m.swapUsedBytes)} of ${humanBytes(m.swapTotalBytes)}`,
  ];
  if (s.psi) lines.push(`pressure (10s stall): cpu ${s.psi.cpuSome10}%, memory ${s.psi.memSome10}%, io ${s.psi.ioSome10}%`);
  for (const f of s.filesystems) {
    lines.push(`disk ${f.mount} ${pct(f.percent)} (${humanBytes(f.usedBytes)} of ${humanBytes(f.totalBytes)}), inodes ${pct(f.inodePercent)}`);
  }
  const byCpu = [...s.processes].sort((a, b) => b.cpuFraction - a.cpuFraction).slice(0, 6);
  const byMem = [...s.processes].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 6);
  const top = [...new Map([...byCpu, ...byMem].map((x) => [x.pid, x])).values()];
  if (top.length) {
    lines.push('top processes:');
    for (const x of top) lines.push(`  ${x.name} (pid ${x.pid}, ${x.user}) cpu ${pct(x.cpuFraction * 100)}, rss ${humanBytes(x.rssBytes)}`);
  }
  if (s.docker.length) {
    lines.push('containers:');
    for (const c of s.docker) {
      lines.push(`  ${c.name} ${c.state}${c.health && c.health !== 'none' ? `/${c.health}` : ''}, restarts ${c.restartCount}, cpu ${pct(c.cpuPercent)}, mem ${humanBytes(c.memBytes)}`);
    }
  }
  if (p.services.length) {
    lines.push('services:');
    for (const v of p.services) lines.push(`  ${v.name} ${v.status.online ? 'online' : 'OFFLINE'}${v.status.latency !== null ? ` ${v.status.latency}ms` : ''}`);
  }
  if (s.degraded.length) lines.push(`collectors with problems: ${s.degraded.join(', ')}`);
  return lines.join('\n');
}

function alertsText(a: AlertState): string {
  const firing = a.events.filter((e) => e.resolvedAt === null);
  const lines = [firing.length ? `${firing.length} firing:` : 'nothing is firing'];
  for (const e of firing) lines.push(`  [${e.severity}] ${e.message} (since ${new Date(e.since).toISOString()}, fired ${e.occurrences}x)`);
  const done = a.events.filter((e) => e.resolvedAt !== null).slice(0, 5);
  if (done.length) {
    lines.push('recently resolved:');
    for (const e of done) lines.push(`  [${e.severity}] ${e.message} (resolved ${new Date(e.resolvedAt ?? e.since).toISOString()})`);
  }
  return lines.join('\n');
}

async function logsText(unit: string, count: number, priority: string | null): Promise<string> {
  const { entries, error } = await readLogs({ unit, lines: Math.min(Math.max(count, 1), LOG_LINES_MAX), priority });
  if (error) throw new ChatError(400, error);
  // Newest first from the reader; a person (and a model) reads oldest first.
  const lines = [...entries].reverse().map((e) => `${new Date(e.ts).toISOString().slice(5, 19).replace('T', ' ')} ${e.priority} ${clip(e.message)}`);
  if (lines.length === 0) return '(no entries)';
  let out = lines.join('\n');
  if (out.length > LOG_CHARS) out = `… earlier lines left out …\n${out.slice(-LOG_CHARS)}`;
  return out;
}

type Resolved = { kind: 'system' | 'user'; unit: string } | { kind: 'docker'; name: string };

/** The unit or container a name means: a dashboard service id, a container, or a running system service. */
async function resolveService(name: string): Promise<Resolved> {
  const control = controlOf(name);
  if (control) return { kind: control.scope, unit: control.unit };
  const box = allowedTargets().docker.find((c) => c === name);
  if (box) return { kind: 'docker', name: box };
  const running = await listUnits();
  const unit = running.find((u) => u === name) ?? running.find((u) => u === `${name}.service`);
  if (unit) return { kind: 'system', unit };
  throw new ChatError(404, `no service called "${name}" that Pulse knows`);
}

/** A user-manager unit has no session bus of its own: point systemctl and journalctl at it (as actions.ts does). */
function userEnv(): NodeJS.ProcessEnv {
  const runtime = `/run/user/${process.getuid?.() ?? 1000}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
}

const SHOW = ['show', '--no-pager', '-p', 'Description,ActiveState,SubState,Result,NRestarts,ExecMainStatus,ActiveEnterTimestamp,MemoryCurrent'];

async function diagnoseText(name: string, sources: ContextSources): Promise<string> {
  const svc = await resolveService(name);
  if (svc.kind === 'docker') {
    const stats = await sources.stats();
    const c = stats.system.docker.find((x) => x.name === svc.name);
    const head = c
      ? `container ${c.name} (${c.image}) ${c.state}, ${c.status}, health ${c.health || 'none'}, restarts ${c.restartCount}, cpu ${pct(c.cpuPercent)}, mem ${humanBytes(c.memBytes)}`
      : `container ${svc.name}`;
    const logs = await run('docker', ['logs', '--tail', '60', svc.name]);
    return `${head}\n\nlast log lines:\n${logs ? clip(logs.slice(-LOG_CHARS), LOG_CHARS) : '(no output)'}`;
  }
  if (svc.kind === 'user') {
    const env = userEnv();
    const show = await run('systemctl', ['--user', ...SHOW, svc.unit], env);
    const log = await run('journalctl', ['--user', '-u', svc.unit, '-n', '60', '--no-pager', '-o', 'short-iso'], env);
    return `systemd user unit ${svc.unit}\n${show || '(no status)'}\n\nlast log lines:\n${log ? clip(log.slice(-LOG_CHARS), LOG_CHARS) : '(no entries)'}`;
  }
  const show = await run('systemctl', [...SHOW, svc.unit]);
  return `systemd unit ${svc.unit}\n${show || '(no status)'}\n\nlast log lines:\n${await logsText(svc.unit, 60, null)}`;
}

async function diskText(sources: ContextSources): Promise<string> {
  const fs = (await sources.stats()).system.filesystems;
  const lines = fs.map((f) => `${f.mount} ${pct(f.percent)} used (${humanBytes(f.usedBytes)} of ${humanBytes(f.totalBytes)}), inodes ${pct(f.inodePercent)}`);
  const docker = await run('docker', ['system', 'df']);
  return `${lines.join('\n')}${docker ? `\n\ndocker system df:\n${docker}` : ''}`;
}

export interface ContextQuery {
  readonly kind: string;
  readonly name?: string;
  readonly lines?: number;
  readonly priority?: string | null;
}

export async function buildContext(q: ContextQuery, sources: ContextSources): Promise<ChatContext> {
  let title: string;
  let text: string;
  switch (q.kind) {
    case 'metrics':
      title = 'Host snapshot';
      text = metricsText(await sources.stats());
      break;
    case 'alerts':
      title = 'Alerts';
      text = alertsText(sources.alerts());
      break;
    case 'logs':
      if (!q.name) throw new ChatError(400, 'name (the unit) required');
      title = `Logs of ${q.name}`;
      text = await logsText(q.name, q.lines ?? 80, q.priority ?? null);
      break;
    case 'diagnose':
      if (!q.name) throw new ChatError(400, 'name required');
      title = `Status of ${q.name}`;
      text = await diagnoseText(q.name, sources);
      break;
    case 'disk':
      title = 'Disk usage';
      text = await diskText(sources);
      break;
    default:
      throw new ChatError(400, 'kind must be metrics, logs, alerts, diagnose or disk');
  }
  return { title, text: redact(text) };
}
