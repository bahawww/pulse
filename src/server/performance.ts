import fs from 'node:fs';
import type { Express, Request, RequestHandler, Response } from 'express';
import type {
  MaintenanceSchedule,
  MaintenanceTask,
  PerformanceState,
  ProcessActionRequest,
  ProcessSignal,
  ResourceLimitTarget,
} from '../shared/contract.js';
import { collectMemory, humanBytes } from './collect/memory.js';
import { runRemote } from './files.js';
import { shq } from './sshLocal.js';
import { loadSetting, recordAction, recentActions, saveSetting } from './store.js';
import { publish } from './stream.js';

/**
 * Server performance management & guardrails controller:
 *  1. Process controls: SIGTERM, SIGKILL, renice +10 / 0 with a strict denylist
 *     and PID-comm verification so recycled PIDs cannot be hit.
 *  2. System maintenance: drop kernel caches, prune unused Docker cache,
 *     vacuum journald, and reset failed systemd units.
 *  3. Resource guardrails: inspect and set persistent MemoryHigh, MemoryMax,
 *     and CPUQuota limits on managed systemd units (system and user slices).
 *  4. Automated maintenance scheduler: weekly Docker/journal cleanup and
 *     optional auto-cache-drop under sustained memory pressure.
 */

const PROTECTED_PROCESSES: ReadonlySet<string> = new Set([
  'systemd',
  'init',
  'kthreadd',
  'sshd',
  'dockerd',
  'containerd',
  'containerd-shim',
  'tailscaled',
  'cloudflared',
  'fail2ban-server',
  'earlyoom',
  'mysqld',
  'mariadbd',
  'postgres',
  'redis-server',
  'Xtigervnc',
  '9router',
]);

const SIGNALS: ReadonlySet<ProcessSignal> = new Set(['TERM', 'KILL', 'NICE_LOW', 'NICE_NORMAL']);
const TASKS: ReadonlySet<MaintenanceTask> = new Set(['drop-caches', 'docker-prune', 'journal-vacuum', 'reset-failed']);

interface ManagedUnit {
  readonly id: string;
  readonly label: string;
  readonly kind: 'systemd-system' | 'systemd-user';
}

const MANAGED_UNITS: readonly ManagedUnit[] = [
  { id: 'opencode-web.service', label: 'OpenCode Web Agent', kind: 'systemd-user' },
  { id: 'hermes-gateway.service', label: 'Hermes Agent Gateway', kind: 'systemd-user' },
  { id: 'hermes-dashboard.service', label: 'Hermes Web Dashboard', kind: 'systemd-user' },
  { id: '9router.service', label: '9router LLM Gateway', kind: 'systemd-system' },
  { id: 'pulse.service', label: 'Pulse Dashboard', kind: 'systemd-system' },
  { id: 'novnc.service', label: 'noVNC WebSocket Proxy', kind: 'systemd-system' },
  { id: 'vncserver@11.service', label: 'TigerVNC Desktop (:11)', kind: 'systemd-system' },
];

// ---------------------------------------------------------------------------
// Two-phase confirmation tokens
// ---------------------------------------------------------------------------

interface PendingToken {
  readonly key: string;
  readonly expiresAt: number;
}

const pendingTokens = new Map<string, PendingToken>();
const CONFIRM_TTL_MS = 30_000;

function issueToken(key: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  pendingTokens.set(token, { key, expiresAt: Date.now() + CONFIRM_TTL_MS });
  if (pendingTokens.size > 60) {
    const oldest = [...pendingTokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) pendingTokens.delete(oldest[0]);
  }
  return token;
}

function consumeToken(token: string | null, expectedKey: string): boolean {
  if (!token) return false;
  const entry = pendingTokens.get(token);
  pendingTokens.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return false;
  return entry.key === expectedKey;
}

// ---------------------------------------------------------------------------
// Process signaling & renice
// ---------------------------------------------------------------------------

function readComm(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < 0) return null;
    return stat.slice(open + 1, close).slice(0, 24);
  } catch {
    return null;
  }
}

export async function performProcessAction(
  req: ProcessActionRequest,
  confirm: string | null,
): Promise<{ ok: boolean; message: string; confirmToken?: string }> {
  const pid = Number(req.pid);
  if (!Number.isInteger(pid) || pid <= 2) {
    return { ok: false, message: 'invalid or system PID' };
  }
  if (pid === process.pid) {
    return { ok: false, message: 'refusing to signal the Pulse server itself' };
  }
  if (!SIGNALS.has(req.signal)) {
    return { ok: false, message: 'unsupported signal' };
  }

  const liveName = readComm(pid);
  if (!liveName) {
    return { ok: false, message: `PID ${pid} is no longer running` };
  }
  if (PROTECTED_PROCESSES.has(liveName) || PROTECTED_PROCESSES.has(req.name)) {
    return { ok: false, message: `${liveName} is a protected core service` };
  }
  if (req.name && liveName !== req.name) {
    return { ok: false, message: `PID ${pid} changed from ${req.name} to ${liveName} — refused` };
  }

  // Renice is non-destructive and executes immediately; TERM/KILL require two-phase confirmation.
  const needsConfirm = req.signal === 'TERM' || req.signal === 'KILL';
  const tokenKey = `proc:${pid}:${liveName}:${req.signal}`;
  if (needsConfirm && !confirm) {
    return {
      ok: true,
      message: 'confirmation required',
      confirmToken: issueToken(tokenKey),
    };
  }
  if (needsConfirm && !consumeToken(confirm, tokenKey)) {
    return { ok: false, message: 'confirmation token expired or invalid — click again' };
  }

  const started = Date.now();
  let cmd: string;
  if (req.signal === 'TERM') {
    cmd = `sudo kill -s TERM ${shq(String(pid))}`;
  } else if (req.signal === 'KILL') {
    cmd = `sudo kill -s KILL ${shq(String(pid))}`;
  } else if (req.signal === 'NICE_LOW') {
    cmd = `sudo renice -n 10 -p ${shq(String(pid))}`;
  } else {
    cmd = `sudo renice -n 0 -p ${shq(String(pid))}`;
  }

  const res = await runRemote(cmd, 64 * 1024);
  const ok = res.code === 0;
  const durationMs = Date.now() - started;
  const verbLabel =
    req.signal === 'TERM'
      ? 'SIGTERM'
      : req.signal === 'KILL'
        ? 'SIGKILL'
        : req.signal === 'NICE_LOW'
          ? 'renice +10'
          : 'renice 0';
  const message = ok
    ? `${verbLabel} sent to ${liveName} (PID ${pid})`
    : `${verbLabel} on ${liveName} (${pid}) failed: ${res.stderr.trim().slice(0, 140) || `exit ${res.code}`}`;

  recordAction({
    ts: Date.now(),
    target: 'process',
    name: `${liveName} (${pid})`,
    action: verbLabel,
    ok,
    message,
    durationMs,
  });
  publish('actions', { entries: recentActions(50) });

  return { ok, message };
}

// ---------------------------------------------------------------------------
// System Maintenance Actions
// ---------------------------------------------------------------------------

export async function performMaintenance(
  task: MaintenanceTask,
  confirm: string | null,
  automated = false,
): Promise<{ ok: boolean; message: string; stdout: string; durationMs: number; confirmToken?: string }> {
  if (!TASKS.has(task)) {
    return { ok: false, message: 'unknown maintenance task', stdout: '', durationMs: 0 };
  }

  const tokenKey = `maint:${task}`;
  if (!automated && !confirm) {
    return {
      ok: true,
      message: 'confirmation required',
      stdout: '',
      durationMs: 0,
      confirmToken: issueToken(tokenKey),
    };
  }
  if (!automated && !consumeToken(confirm, tokenKey)) {
    return { ok: false, message: 'confirmation token expired or invalid — click again', stdout: '', durationMs: 0 };
  }

  const started = Date.now();
  let ok = false;
  let message = '';
  let stdout = '';

  if (task === 'drop-caches') {
    const beforeAvail = collectMemory().availableBytes;
    const res = await runRemote('sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null', 16 * 1024);
    const afterAvail = collectMemory().availableBytes;
    const freed = Math.max(0, afterAvail - beforeAvail);
    ok = res.code === 0;
    message = ok
      ? `Dropped kernel page & slab caches (${freed > 0 ? `freed ${humanBytes(freed)}` : 'cache already minimal'})`
      : `Failed to drop caches: ${res.stderr.trim() || `exit ${res.code}`}`;
  } else if (task === 'docker-prune') {
    const res = await runRemote('docker image prune -f && docker builder prune -f', 128 * 1024);
    ok = res.code === 0;
    stdout = res.stdout.toString('utf8').trim();
    const reclaimed = [...stdout.matchAll(/Total reclaimed space:\s*([^\n]+)/gi)].map((m) => m[1]?.trim()).filter(Boolean);
    message = ok
      ? `Pruned unused Docker images & build cache (${reclaimed.length > 0 ? reclaimed.join(', ') : '0 B reclaimed'})`
      : `Docker prune failed: ${res.stderr.trim() || `exit ${res.code}`}`;
  } else if (task === 'journal-vacuum') {
    const res = await runRemote('sudo journalctl --vacuum-size=100M --vacuum-time=7d 2>&1', 128 * 1024);
    ok = res.code === 0;
    stdout = (res.stdout.toString('utf8') + '\n' + res.stderr).trim();
    const match = /freed\s+([\d.]+\s*[A-Za-z]+)\s+of archived journals/i.exec(stdout);
    message = ok
      ? `Vacuumed systemd journal (${match?.[1] ? `freed ${match[1]}` : 'already within 100M / 7d target'})`
      : `Journal vacuum failed: ${stdout.slice(0, 140)}`;
  } else if (task === 'reset-failed') {
    const res = await runRemote('sudo systemctl reset-failed && systemctl --user reset-failed', 32 * 1024);
    ok = res.code === 0;
    message = ok ? 'Cleared failed systemd unit states' : `Reset-failed error: ${res.stderr.trim() || `exit ${res.code}`}`;
  }

  const durationMs = Date.now() - started;
  if (ok) {
    const sched = getSchedule();
    saveSetting('maintenance_schedule', {
      ...sched,
      lastRunAt: { ...sched.lastRunAt, [task]: Date.now() },
    });
  }

  recordAction({
    ts: Date.now(),
    target: 'maintenance',
    name: task,
    action: automated ? 'auto-run' : 'run',
    ok,
    message,
    durationMs,
  });
  publish('actions', { entries: recentActions(50) });

  return { ok, message, stdout: stdout.slice(0, 800), durationMs };
}

// ---------------------------------------------------------------------------
// Resource Guardrails (Systemd cgroup limits)
// ---------------------------------------------------------------------------

const INFINITY_UINT64 = 18446744073709551615n;

function parseSystemdBytes(val: string | undefined): number | null {
  if (!val || val === 'infinity' || val === '[not set]') return null;
  try {
    const n = BigInt(val);
    if (n <= 0n || n >= INFINITY_UINT64) return null;
    return Number(n);
  } catch {
    return null;
  }
}

function parseSystemdCpuQuota(val: string | undefined): number | null {
  if (!val || val === 'infinity' || val === '[not set]') return null;
  // systemctl show CPUQuotaPerSecUSec outputs e.g. "2s" (200%), "500ms" (50%), or "infinity"
  const secMatch = /^([\d.]+)s$/.exec(val);
  if (secMatch?.[1]) return Math.round(Number.parseFloat(secMatch[1]) * 100);
  const msMatch = /^([\d.]+)ms$/.exec(val);
  if (msMatch?.[1]) return Math.round(Number.parseFloat(msMatch[1]) / 10);
  return null;
}

export async function readResourceLimits(): Promise<ResourceLimitTarget[]> {
  const sysUnits = MANAGED_UNITS.filter((u) => u.kind === 'systemd-system').map((u) => shq(u.id)).join(' ');
  const userUnits = MANAGED_UNITS.filter((u) => u.kind === 'systemd-user').map((u) => shq(u.id)).join(' ');

  const cmd = [
    `systemctl show ${sysUnits} -p Id,MemoryCurrent,MemoryHigh,MemoryMax,CPUQuotaPerSecUSec`,
    `echo "===SPLIT==="`,
    `systemctl --user show ${userUnits} -p Id,MemoryCurrent,MemoryHigh,MemoryMax,CPUQuotaPerSecUSec`,
  ].join(' ; ');

  const res = await runRemote(cmd, 128 * 1024);
  const raw = res.stdout.toString('utf8');
  const byId = new Map<string, Record<string, string>>();

  for (const block of raw.replace('===SPLIT===', '\n').split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.trim().split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    if (props.Id) byId.set(props.Id, props);
  }

  return MANAGED_UNITS.map((u) => {
    const p = byId.get(u.id) ?? {};
    return {
      kind: u.kind,
      id: u.id,
      label: u.label,
      memoryHighBytes: parseSystemdBytes(p.MemoryHigh),
      memoryMaxBytes: parseSystemdBytes(p.MemoryMax),
      cpuQuotaPercent: parseSystemdCpuQuota(p.CPUQuotaPerSecUSec),
      currentBytes: parseSystemdBytes(p.MemoryCurrent) ?? 0,
    };
  });
}

export async function applyResourceLimit(input: {
  id: string;
  memoryMaxMB: number | null;
  cpuQuotaPercent: number | null;
}): Promise<{ ok: boolean; message: string }> {
  const unit = MANAGED_UNITS.find((u) => u.id === input.id);
  if (!unit) return { ok: false, message: 'unknown or unmanaged service unit' };

  const memMax =
    input.memoryMaxMB !== null && Number.isFinite(input.memoryMaxMB) && input.memoryMaxMB >= 128
      ? Math.min(14336, Math.round(input.memoryMaxMB))
      : null;
  // Set MemoryHigh to ~75% of MemoryMax so the kernel throttles/reclaims gently before hard OOM.
  const memHigh = memMax !== null ? Math.round(memMax * 0.75) : null;

  const cpuQuota =
    input.cpuQuotaPercent !== null && Number.isFinite(input.cpuQuotaPercent) && input.cpuQuotaPercent >= 25
      ? Math.min(1600, Math.round(input.cpuQuotaPercent))
      : null;

  const memHighArg = memHigh !== null ? `MemoryHigh=${memHigh}M` : 'MemoryHigh=infinity';
  const memMaxArg = memMax !== null ? `MemoryMax=${memMax}M` : 'MemoryMax=infinity';
  const cpuArg = cpuQuota !== null ? `CPUQuota=${cpuQuota}%` : 'CPUQuota=';

  const prefix = unit.kind === 'systemd-user' ? 'systemctl --user' : 'sudo systemctl';
  const cmd = `${prefix} set-property ${shq(unit.id)} ${shq(memHighArg)} ${shq(memMaxArg)} ${shq(cpuArg)}`;

  const started = Date.now();
  const res = await runRemote(cmd, 32 * 1024);
  const ok = res.code === 0;
  const durationMs = Date.now() - started;

  const summary = [
    memMax !== null ? `RAM max ${memMax}M (high ${memHigh}M)` : 'RAM uncapped',
    cpuQuota !== null ? `CPU ${cpuQuota}%` : 'CPU uncapped',
  ].join(', ');

  const message = ok
    ? `Updated guardrail on ${unit.label}: ${summary}`
    : `Failed to update ${unit.id}: ${res.stderr.trim() || `exit ${res.code}`}`;

  recordAction({
    ts: Date.now(),
    target: 'guardrail',
    name: unit.id,
    action: summary,
    ok,
    message,
    durationMs,
  });
  publish('actions', { entries: recentActions(50) });

  return { ok, message };
}

// ---------------------------------------------------------------------------
// Maintenance Schedule & Automated Guardrail Tick
// ---------------------------------------------------------------------------

const DEFAULT_SCHEDULE: MaintenanceSchedule = {
  autoDockerPruneWeekly: true,
  autoJournalVacuumWeekly: true,
  autoDropCacheOnPressure: true,
  lastRunAt: {},
};

export function getSchedule(): MaintenanceSchedule {
  const saved = loadSetting<Partial<MaintenanceSchedule>>('maintenance_schedule', {});
  return {
    autoDockerPruneWeekly: typeof saved.autoDockerPruneWeekly === 'boolean' ? saved.autoDockerPruneWeekly : DEFAULT_SCHEDULE.autoDockerPruneWeekly,
    autoJournalVacuumWeekly: typeof saved.autoJournalVacuumWeekly === 'boolean' ? saved.autoJournalVacuumWeekly : DEFAULT_SCHEDULE.autoJournalVacuumWeekly,
    autoDropCacheOnPressure: typeof saved.autoDropCacheOnPressure === 'boolean' ? saved.autoDropCacheOnPressure : DEFAULT_SCHEDULE.autoDropCacheOnPressure,
    lastRunAt: saved.lastRunAt && typeof saved.lastRunAt === 'object' ? saved.lastRunAt : {},
  };
}

export function updateSchedule(patch: Partial<MaintenanceSchedule>): MaintenanceSchedule {
  const current = getSchedule();
  const next: MaintenanceSchedule = {
    autoDockerPruneWeekly: typeof patch.autoDockerPruneWeekly === 'boolean' ? patch.autoDockerPruneWeekly : current.autoDockerPruneWeekly,
    autoJournalVacuumWeekly: typeof patch.autoJournalVacuumWeekly === 'boolean' ? patch.autoJournalVacuumWeekly : current.autoJournalVacuumWeekly,
    autoDropCacheOnPressure: typeof patch.autoDropCacheOnPressure === 'boolean' ? patch.autoDropCacheOnPressure : current.autoDropCacheOnPressure,
    lastRunAt: current.lastRunAt,
  };
  saveSetting('maintenance_schedule', next);
  return next;
}

const WEEK_MS = 7 * 24 * 3_600_000;
const PRESSURE_COOLDOWN_MS = 30 * 60_000;
let lastPressureDropAt = 0;
let tickRunning = false;

/** Called periodically by the server sampler to enforce automated maintenance & memory pressure relief. */
export async function evaluateGuardrails(memPercent: number): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const sched = getSchedule();
    const now = Date.now();

    if (sched.autoDropCacheOnPressure && memPercent >= 85 && now - lastPressureDropAt > PRESSURE_COOLDOWN_MS) {
      lastPressureDropAt = now;
      await performMaintenance('drop-caches', null, true);
    }

    const lastDocker = sched.lastRunAt['docker-prune'] ?? 0;
    if (sched.autoDockerPruneWeekly && now - lastDocker > WEEK_MS) {
      await performMaintenance('docker-prune', null, true);
    }

    const lastJournal = sched.lastRunAt['journal-vacuum'] ?? 0;
    if (sched.autoJournalVacuumWeekly && now - lastJournal > WEEK_MS) {
      await performMaintenance('journal-vacuum', null, true);
    }
  } catch {
    /* background guardrail errors never crash the sampler */
  } finally {
    tickRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Express Routes
// ---------------------------------------------------------------------------

export function registerPerformanceRoutes(
  app: Express,
  readLimiter: RequestHandler,
  writeLimiter: RequestHandler,
  requireControl: RequestHandler,
): void {
  app.get('/api/performance', readLimiter, requireControl, (_req: Request, res: Response) => {
    void readResourceLimits()
      .then((limits) => {
        const mem = collectMemory();
        const state: PerformanceState = {
          limits,
          schedule: getSchedule(),
          reclaimableCacheBytes: mem.cachedBytes ?? 0,
          protectedNames: [...PROTECTED_PROCESSES],
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json(state);
      })
      .catch(() => res.status(500).json({ error: 'failed to read performance state' }));
  });

  app.post('/api/performance/process', writeLimiter, requireControl, (req: Request, res: Response) => {
    const body = req.body as { pid?: unknown; name?: unknown; signal?: unknown; confirm?: unknown };
    void performProcessAction(
      {
        pid: Number(body.pid ?? 0),
        name: String(body.name ?? ''),
        signal: body.signal as ProcessSignal,
      },
      typeof body.confirm === 'string' ? body.confirm : null,
    )
      .then((result) => res.status(result.ok ? 200 : 400).json(result))
      .catch(() => res.status(500).json({ error: 'process action failed' }));
  });

  app.post('/api/performance/maintenance', writeLimiter, requireControl, (req: Request, res: Response) => {
    const body = req.body as { task?: unknown; confirm?: unknown };
    void performMaintenance(
      body.task as MaintenanceTask,
      typeof body.confirm === 'string' ? body.confirm : null,
      false,
    )
      .then((result) => res.status(result.ok ? 200 : 400).json(result))
      .catch(() => res.status(500).json({ error: 'maintenance task failed' }));
  });

  app.post('/api/performance/limits', writeLimiter, requireControl, (req: Request, res: Response) => {
    const body = req.body as { id?: unknown; memoryMaxMB?: unknown; cpuQuotaPercent?: unknown };
    void applyResourceLimit({
      id: String(body.id ?? ''),
      memoryMaxMB: typeof body.memoryMaxMB === 'number' ? body.memoryMaxMB : null,
      cpuQuotaPercent: typeof body.cpuQuotaPercent === 'number' ? body.cpuQuotaPercent : null,
    })
      .then((result) => res.status(result.ok ? 200 : 400).json(result))
      .catch(() => res.status(500).json({ error: 'limit update failed' }));
  });

  app.put('/api/performance/schedule', writeLimiter, requireControl, (req: Request, res: Response) => {
    const body = req.body as Partial<MaintenanceSchedule>;
    const schedule = updateSchedule(body);
    res.json({ ok: true, schedule });
  });
}
