/**
 * Pure helpers for the agent launcher: session names, trust-prompt answers and
 * takeover-link scraping. No tmux calls here, so they test without a terminal.
 */
import type { Request, Response } from 'express';
import { AGENT_LIMIT, type AgentKind, type AgentSession } from '../shared/contract.js';
import { runRemote, type RunResult } from './files.js';
import { shq } from './sshLocal.js';
import { recordAction } from './store.js';

/** Allowed agent session names; the charset keeps them safe inside a tmux/shell argument. */
export const AGENT_NAME = /^(agy|cc)-[A-Za-z0-9_-]{1,36}$/;

const PREFIX: Record<AgentKind, string> = { agy: 'agy', claude: 'cc' };

export function agentKindOf(name: string): AgentKind | null {
  if (name.startsWith('agy-')) return 'agy';
  if (name.startsWith('cc-')) return 'claude';
  return null;
}

/** `<prefix>-HHMM`, then `-2`, `-3`... until it is free. */
export function nextName(kind: AgentKind, taken: readonly string[], now: Date): string {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const base = `${PREFIX[kind]}-${hhmm}`;
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

/** Keys that accept the folder-trust prompt, or null when the pane shows no such prompt. */
export function trustKeys(kind: AgentKind, pane: string): readonly string[] | null {
  if (kind === 'agy') return /trust the contents of this project/i.test(pane) ? ['Enter'] : null;
  // Claude's menu starts on "No, exit"; Down moves to "Yes".
  return /Yes, I trust this folder/.test(pane) && /No, exit/.test(pane) ? ['Down', 'Enter'] : null;
}

/** The newest takeover link in pane text or a log; agy logs only carry the id, so rebuild the URL. */
export function findLink(kind: AgentKind, text: string): string | null {
  if (kind === 'claude') {
    return [...text.matchAll(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g)].pop()?.[0] ?? null;
  }
  const hits = [
    ...[...text.matchAll(/https:\/\/antigravity\.google\.com\/r\/[A-Za-z0-9-]+/g)].map((m) => ({ at: m.index, url: m[0] })),
    ...[...text.matchAll(/\[remote-control-([A-Za-z0-9-]+)\]/g)].map((m) => ({ at: m.index, url: `https://antigravity.google.com/r/${m[1]}` })),
  ];
  return hits.sort((a, b) => a.at - b.at).pop()?.url ?? null;
}

/** Everything that touches the machine, so tests can script it. */
export interface AgentDeps {
  run(cmd: string): Promise<RunResult>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** How long start waits for a takeover link. */
  timeoutMs: number;
}

// runRemote kills commands at 20 s, so 18 s leaves room for the last poll.
const realDeps: AgentDeps = {
  run: (cmd) => runRemote(cmd, 256 * 1024),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  timeoutMs: 18_000,
};

const DIR = '~/.cache/pulse-agents';
const logOf = (name: string): string => `${DIR}/${shq(`${name}.log`)}`;
const LOG_TAIL = (name: string): string => `tail -c 65536 ${logOf(name)} 2>/dev/null`;
const LIST_FORMAT = '#{session_name}\t#{session_created}\t#{session_activity}\t#{@agent_link}';
/** Exact session, then its current window: pane and option commands reject a bare `=name`. */
export const paneTarget = (name: string): string => shq(`=${name}:`);
const text = (r: RunResult): string => r.stdout.toString('utf8');

/** Agent sessions in tmux; also drops logs of sessions that are gone. String = error text. */
export async function listAgents(deps: AgentDeps = realDeps): Promise<AgentSession[] | string> {
  const r = await deps.run(`command -v tmux >/dev/null || { echo 'tmux is not installed' >&2; exit 3; }; tmux list-sessions -F ${shq(LIST_FORMAT)} 2>/dev/null; true`);
  if (r.code !== 0) return r.stderr.trim() || 'cannot list agent sessions';
  const rows = text(r).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const live = rows.filter(([n = '']) => AGENT_NAME.test(n));
  const names = live.map(([n = '']) => n);
  // One call: agy logs (where its link lives), then delete logs of dead sessions.
  const agy = names.filter((n) => agentKindOf(n) === 'agy');
  const logs = await deps.run(
    [
      ...agy.map((n) => `echo ${shq(`@@${n}`)}; ${LOG_TAIL(n)}`),
      `for f in ${DIR}/*.log; do case "$(basename "$f" .log)" in ${names.map(shq).join('|') || "''"}) ;; *) rm -f "$f";; esac; done`,
      'true',
    ].join('; '),
  );
  const tails = new Map<string, string>();
  for (const part of text(logs).split('@@').slice(1)) {
    const nl = part.indexOf('\n');
    tails.set(part.slice(0, nl), part.slice(nl + 1));
  }
  const out: AgentSession[] = [];
  for (const [name = '', created, activity, saved] of live) {
    const kind = agentKindOf(name) as AgentKind;
    let link = (kind === 'agy' ? findLink(kind, tails.get(name) ?? '') : null) ?? (saved || null);
    // Claude prints its link on screen only; read the pane when it was never stored.
    if (!link && kind === 'claude') link = findLink(kind, text(await deps.run(`tmux capture-pane -p -J -t ${paneTarget(name)}`)));
    out.push({ kind, name, link, created: Number(created) * 1000 || 0, activity: Number(activity) * 1000 || 0 });
  }
  return out;
}

type Reply<T> = { status: number; body: { error?: string } & T };

/** Starts a session, answers its trust prompt once, and waits for the takeover link. */
export async function startAgent(kind: AgentKind, deps: AgentDeps = realDeps): Promise<Reply<{ session?: AgentSession }>> {
  const started = Date.now();
  const listed = await listAgents(deps);
  if (typeof listed === 'string') return { status: 503, body: { error: listed } };
  if (listed.filter((s) => s.kind === kind).length >= AGENT_LIMIT) return { status: 409, body: { error: `${AGENT_LIMIT} running: stop one first` } };
  const name = nextName(kind, listed.map((s) => s.name), deps.now());
  const q = paneTarget(name);
  const command = kind === 'agy' ? `~/.local/bin/agy --remote-control --log-file ${logOf(name)}` : `~/.local/bin/claude --remote-control ${shq(name)}`;
  const made = await deps.run(`mkdir -p ${DIR} && tmux new-session -d -s ${shq(name)} -c ~ ${command}`);
  let link: string | null = null;
  let error = made.code === 0 ? '' : made.stderr.trim() || 'cannot start session';
  if (!error) {
    let answered = false;
    const t0 = deps.now().getTime();
    while (!link && deps.now().getTime() - t0 < deps.timeoutMs) {
      const pane = text(await deps.run(`tmux capture-pane -p -J -t ${q}${kind === 'agy' ? `; ${LOG_TAIL(name)}` : ''}`));
      link = findLink(kind, pane);
      const keys = answered || link ? null : trustKeys(kind, pane);
      if (keys) {
        answered = true;
        await deps.run(`tmux send-keys -t ${q} ${keys.join(' ')}`);
      }
      if (!link) await deps.sleep(600);
    }
    if (link) await deps.run(`tmux set-option -t ${q} @agent_link ${shq(link)}`);
  }
  recordAction({ target: 'agent', name, action: 'start', ok: !error, message: error || link || 'no link yet', durationMs: Date.now() - started, ts: Date.now() });
  if (error) return { status: 500, body: { error } };
  const now = deps.now().getTime();
  return { status: 200, body: { session: { kind, name, link, created: now, activity: now } } };
}

export async function stopAgent(name: string, deps: AgentDeps = realDeps): Promise<Reply<{ ok?: true }>> {
  if (!AGENT_NAME.test(name)) return { status: 400, body: { error: 'not an agent session' } };
  const started = Date.now();
  const r = await deps.run(`tmux kill-session -t ${shq(`=${name}`)} && rm -f ${logOf(name)}`);
  const ok = r.code === 0;
  const message = ok ? 'done' : r.stderr.trim() || 'no such session';
  recordAction({ target: 'agent', name, action: 'stop', ok, message, durationMs: Date.now() - started, ts: Date.now() });
  return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: message } };
}

export async function getAgents(_req: Request, res: Response): Promise<void> {
  const r = await listAgents();
  if (typeof r === 'string') res.status(503).json({ error: r });
  else res.json({ sessions: r });
}

export async function postAgent(req: Request, res: Response): Promise<void> {
  const kind = (req.body as { kind?: unknown }).kind;
  if (kind !== 'agy' && kind !== 'claude') {
    res.status(400).json({ error: 'kind: agy or claude' });
    return;
  }
  const r = await startAgent(kind);
  res.status(r.status).json(r.body);
}

export async function postStopAgent(req: Request, res: Response): Promise<void> {
  const name = (req.body as { name?: unknown }).name;
  const r = await stopAgent(typeof name === 'string' ? name : '');
  res.status(r.status).json(r.body);
}
