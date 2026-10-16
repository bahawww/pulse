import type { Request, Response } from 'express';
import { runRemote } from './files.js';
import { shq } from './sshLocal.js';
import { recordAction } from './store.js';

/**
 * tmux sessions for the terminal's session manager. They run as the SSH user
 * over the loopback login, outside this service's sandbox (PrivateTmp would
 * otherwise hide the tmux socket). A tmux session can have several clients at
 * once, so the same session can be open on a laptop and a phone together; a
 * terminal window attaches with `?tmux=<name>` (terminal.ts) and closing the
 * window only detaches.
 */

/** tmux turns '.' and ':' in names into '_'; keep names to what survives unchanged. */
export const TMUX_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface TmuxSession {
  readonly name: string;
  readonly windows: number;
  /** How many clients (devices, windows) are attached right now. */
  readonly attached: number;
  /** Epoch ms. */
  readonly created: number;
  readonly activity: number;
}

const FORMAT = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}';

export async function listSessions(): Promise<TmuxSession[] | string> {
  const r = await runRemote(`command -v tmux >/dev/null || { echo 'tmux is not installed' >&2; exit 3; }; tmux list-sessions -F ${shq(FORMAT)} 2>/dev/null; true`, 256 * 1024);
  if (r.code !== 0) return r.stderr.trim() || 'cannot list tmux sessions';
  return r.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', windows, attached, created, activity] = line.split('\t');
      return { name, windows: Number(windows) || 0, attached: Number(attached) || 0, created: Number(created) * 1000 || 0, activity: Number(activity) * 1000 || 0 };
    })
    .sort((a, b) => b.activity - a.activity);
}

function audit(action: string, name: string, ok: boolean, message: string, started: number): void {
  recordAction({ ts: Date.now(), target: 'tmux', name, action, ok, message, durationMs: Date.now() - started });
}

/** Express handlers, mounted behind the admin gate in index.ts. */
export async function getSessions(_req: Request, res: Response): Promise<void> {
  const list = await listSessions();
  if (typeof list === 'string') res.status(503).json({ error: list });
  else res.json({ sessions: list });
}

export async function killSession(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const name = (req.body as { name?: unknown }).name;
  if (typeof name !== 'string' || !TMUX_RE.test(name)) {
    res.status(400).json({ error: 'bad session name' });
    return;
  }
  const r = await runRemote(`tmux kill-session -t ${shq(`=${name}`)}`, 64 * 1024);
  const ok = r.code === 0;
  audit('kill', name, ok, ok ? 'done' : r.stderr.trim() || 'failed', started);
  if (ok) res.json({ ok: true });
  else res.status(404).json({ error: r.stderr.trim() || 'no such session' });
}

export async function renameSession(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const body = req.body as { name?: unknown; to?: unknown };
  if (typeof body.name !== 'string' || typeof body.to !== 'string' || !TMUX_RE.test(body.name) || !TMUX_RE.test(body.to)) {
    res.status(400).json({ error: 'names: 1-40 of A-Z a-z 0-9 _ -' });
    return;
  }
  const r = await runRemote(`tmux rename-session -t ${shq(`=${body.name}`)} ${shq(body.to)}`, 64 * 1024);
  const ok = r.code === 0;
  audit('rename', `${body.name} -> ${body.to}`, ok, ok ? 'done' : r.stderr.trim() || 'failed', started);
  if (ok) res.json({ ok: true });
  else res.status(400).json({ error: r.stderr.trim() || 'cannot rename' });
}
