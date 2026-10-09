import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import pty from 'node-pty';
import { WebSocketServer, type WebSocket } from 'ws';

import { isValid, onSessionEnd, sessionHash } from './session.js';

/**
 * Browser terminal: WebSocket <-> node-pty.
 *
 * The pty runs the OpenSSH client against this host's loopback sshd by default
 * (TERMINAL_MODE=ssh). That keeps the shell outside this service's systemd
 * sandbox (NoNewPrivileges, ProtectHome=read-only), so sudo and writes to $HOME
 * work, while node-pty still gives a real local pty: exact resize, flow control
 * and process lifetime this file owns. TERMINAL_MODE=local spawns $SHELL
 * directly instead, which is faster but inherits the sandbox.
 *
 * A terminal is a full shell as the SSH user (who has NOPASSWD sudo), so:
 *
 *  - It needs a logged-in session (cookie checked on the upgrade request). The
 *    login page is the only password prompt; this file has none of its own.
 *  - The Origin header must match Host, which stops cross-site WebSocket
 *    hijacking from a page the operator happens to visit.
 *  - Logging out, or the session expiring, kills that login's shells.
 *  - The SSH key only works from loopback (authorized_keys `from=`), and the
 *    server host key is pinned through a known_hosts file written from
 *    /etc/ssh, with StrictHostKeyChecking=yes.
 *
 * Shells outlive their WebSocket. A dropped connection or a page reload leaves
 * the pty running for DETACH_MS; the browser reattaches with `?sid=` and gets
 * the recent output replayed. Only the login that started a shell can attach it.
 */

const MODE = process.env.TERMINAL_MODE === 'local' ? 'local' : 'ssh';
const SSH_HOST = process.env.TERMINAL_SSH_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.TERMINAL_SSH_PORT ?? 22);
const SSH_USER = process.env.TERMINAL_SSH_USER ?? os.userInfo().username;
const HOME = process.env.HOME ?? os.homedir();
const SSH_KEY = process.env.TERMINAL_SSH_KEY ?? `${HOME}/.ssh/dashboard_terminal`;
const HOST_PUBKEY = process.env.TERMINAL_HOST_PUBKEY ?? '/etc/ssh/ssh_host_ed25519_key.pub';
const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const KNOWN_HOSTS = path.join(DATA_DIR, 'terminal_known_hosts');
const HOST_ALIAS = 'dashboard-local';

const MAX_SESSIONS = 12;
const IDLE_MS = 60 * 60_000;
/** How long a shell with no browser attached keeps running. */
const DETACH_MS = 15 * 60_000;
/** Recent output kept per shell for replay on reattach. */
const REPLAY_BYTES = 512 * 1024;
/** Output is coalesced for this long before it goes out as one frame. */
const FLUSH_MS = 6;
/** Pause the pty when the socket has this much unsent, resume below LOW_WATER. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 128 * 1024;
const PATH = '/api/terminal';

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

interface Shell {
  readonly id: string;
  readonly login: string;
  readonly pty: pty.IPty;
  readonly started: number;
  ws: WebSocket | null;
  /** Ring of recent output chunks, newest last, at most REPLAY_BYTES in total. */
  replay: string[];
  replaySize: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
  detach: NodeJS.Timeout | null;
  paused: boolean;
  cols: number;
  rows: number;
  exited: boolean;
}

const shells = new Map<string, Shell>();

onSessionEnd((hash) => {
  for (const s of [...shells.values()]) if (s.login === hash) kill(s, 'logged out', 4401);
});

type Out =
  | { t: 'hello'; sid: string; resumed: boolean; mode: string; pid: number }
  | { t: 'o'; d: string }
  | { t: 'exit'; code: number; signal?: number }
  | { t: 'pong'; ts: number };

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** known_hosts line pinning this host's ed25519 key under a fixed alias. Null when unreadable. */
function writeKnownHosts(): boolean {
  try {
    const [type, key] = fs.readFileSync(HOST_PUBKEY, 'utf8').trim().split(/\s+/);
    if (!type || !key) return false;
    fs.writeFileSync(KNOWN_HOSTS, `${HOST_ALIAS} ${type} ${key}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function spawnShell(cols: number, rows: number): pty.IPty | string {
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME,
    USER: SSH_USER,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
  const opts = { name: 'xterm-256color', cols, rows, cwd: HOME, env };
  if (MODE === 'local') {
    const shell = process.env.SHELL ?? '/bin/bash';
    return pty.spawn(shell, ['-l'], opts);
  }
  if (!fs.existsSync(SSH_KEY)) return 'terminal key missing';
  if (!writeKnownHosts()) return 'cannot read host key for pinning';
  return pty.spawn(
    '/usr/bin/ssh',
    [
      '-F', '/dev/null',
      '-tt',
      '-i', SSH_KEY,
      '-p', String(SSH_PORT),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', `HostKeyAlias=${HOST_ALIAS}`,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ConnectTimeout=10',
      '-o', 'LogLevel=ERROR',
      '-o', 'SendEnv=COLORTERM',
      `${SSH_USER}@${SSH_HOST}`,
    ],
    opts,
  );
}

function emit(s: Shell, msg: Out): void {
  const ws = s.ws;
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg), () => {
    // Flow control: resume a paused pty once the socket has drained.
    if (s.paused && s.ws === ws && ws.bufferedAmount < LOW_WATER) {
      s.paused = false;
      s.pty.resume();
    }
  });
  if (!s.paused && ws.bufferedAmount > HIGH_WATER) {
    s.paused = true;
    s.pty.pause();
  }
}

function flush(s: Shell): void {
  s.flushTimer = null;
  if (!s.pending) return;
  const d = s.pending;
  s.pending = '';
  emit(s, { t: 'o', d });
}

function remember(s: Shell, d: string): void {
  s.replay.push(d);
  s.replaySize += d.length;
  while (s.replaySize > REPLAY_BYTES && s.replay.length > 1) s.replaySize -= s.replay.shift()?.length ?? 0;
}

function touch(s: Shell): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => kill(s, 'idle timeout', 4408), IDLE_MS);
}

function kill(s: Shell, reason: string, code = 1000): void {
  if (!shells.delete(s.id)) return;
  if (s.idle) clearTimeout(s.idle);
  if (s.detach) clearTimeout(s.detach);
  if (s.flushTimer) clearTimeout(s.flushTimer);
  flush(s);
  console.log(`[terminal] end ${s.id.slice(0, 8)}: ${reason} after ${Math.round((Date.now() - s.started) / 1000)}s (${shells.size} left)`);
  if (!s.exited) {
    try {
      s.pty.kill('SIGHUP');
    } catch {
      /* already gone */
    }
  }
  if (s.ws && s.ws.readyState === s.ws.OPEN) s.ws.close(code, reason);
  s.ws = null;
}

function create(login: string, cols: number, rows: number): Shell | string {
  const p = spawnShell(cols, rows);
  if (typeof p === 'string') return p;
  const s: Shell = {
    id: randomBytes(16).toString('hex'),
    login,
    pty: p,
    started: Date.now(),
    ws: null,
    replay: [],
    replaySize: 0,
    pending: '',
    flushTimer: null,
    idle: null,
    detach: null,
    paused: false,
    cols,
    rows,
    exited: false,
  };
  shells.set(s.id, s);
  touch(s);
  p.onData((d) => {
    remember(s, d);
    s.pending += d;
    if (!s.flushTimer) s.flushTimer = setTimeout(() => flush(s), FLUSH_MS);
  });
  p.onExit(({ exitCode, signal }) => {
    s.exited = true;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    flush(s);
    emit(s, { t: 'exit', code: exitCode, signal });
    kill(s, `shell exited ${exitCode}`);
  });
  console.log(`[terminal] spawn ${s.id.slice(0, 8)} pid=${p.pid} mode=${MODE} (${shells.size} active)`);
  return s;
}

function clampSize(v: string | null, min: number, max: number, dflt: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/** Call from server.on('upgrade'). Leaves other upgrade paths untouched. */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== PATH) {
    socket.destroy();
    return;
  }
  const deny = (status: string, why: string): void => {
    console.warn(`[terminal] denied ${req.socket.remoteAddress} origin=${req.headers.origin} host=${req.headers.host}: ${why}`);
    reject(socket, status);
  };
  if (!originAllowed(req)) return deny('403 Forbidden', 'origin does not match host');
  const login = sessionHash(req);
  if (!login) return deny('401 Unauthorized', 'no valid login session');

  const sid = url.searchParams.get('sid');
  const existing = sid ? shells.get(sid) : undefined;
  const resumable = existing && existing.login === login ? existing : undefined;
  if (!resumable && shells.size >= MAX_SESSIONS) return deny('429 Too Many Requests', 'too many terminal windows');
  const cols = clampSize(url.searchParams.get('cols'), 1, 500, 80);
  const rows = clampSize(url.searchParams.get('rows'), 1, 200, 24);

  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, login, resumable, cols, rows, req.socket.remoteAddress ?? '?'));
}

function attach(ws: WebSocket, login: string, found: Shell | undefined, cols: number, rows: number, peer: string): void {
  let s: Shell;
  if (found) {
    s = found;
    if (s.detach) clearTimeout(s.detach);
    s.detach = null;
    // One browser view per shell: a second tab takes it over.
    if (s.ws && s.ws !== ws) s.ws.close(4409, 'opened elsewhere');
  } else {
    const made = create(login, cols, rows);
    if (typeof made === 'string') {
      ws.send(JSON.stringify({ t: 'o', d: `\r\n\x1b[31m${made}\x1b[0m\r\n` }));
      ws.close(1011, made);
      return;
    }
    s = made;
  }
  s.ws = ws;
  if (s.paused) {
    s.paused = false;
    s.pty.resume();
  }
  console.log(`[terminal] ${found ? 'resume' : 'open'} ${s.id.slice(0, 8)} from ${peer}`);

  emit(s, { t: 'hello', sid: s.id, resumed: !!found, mode: MODE, pid: s.pty.pid });
  if (found) {
    // Pending output is already part of the replay; send it once.
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    s.pending = '';
    if (s.replaySize > 0) emit(s, { t: 'o', d: s.replay.join('') });
  }

  ws.on('message', (raw) => {
    if (s.ws !== ws) return;
    if (!isValid(login)) {
      kill(s, 'login expired', 4401);
      return;
    }
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown; ts?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Pings keep the latency readout fresh but do not count as activity.
    if (msg.type !== 'ping') touch(s);
    if (msg.type === 'input' && typeof msg.data === 'string') {
      s.pty.write(msg.data);
    } else if (msg.type === 'resize') {
      const c = Number(msg.cols);
      const r = Number(msg.rows);
      if (Number.isInteger(c) && Number.isInteger(r) && c >= 1 && c <= 500 && r >= 1 && r <= 200 && (c !== s.cols || r !== s.rows)) {
        s.cols = c;
        s.rows = r;
        s.pty.resize(c, r);
      }
    } else if (msg.type === 'redraw') {
      // Reattached full-screen apps repaint on SIGWINCH; nudge the size to send one.
      if (s.cols > 1) {
        s.pty.resize(s.cols - 1, s.rows);
        setTimeout(() => !s.exited && s.pty.resize(s.cols, s.rows), 30);
      }
    } else if (msg.type === 'ping' && typeof msg.ts === 'number') {
      emit(s, { t: 'pong', ts: msg.ts });
    } else if (msg.type === 'kill') {
      kill(s, 'closed by user');
    }
  });

  const gone = (): void => {
    if (s.ws !== ws) return;
    s.ws = null;
    if (!shells.has(s.id)) return;
    if (s.detach) clearTimeout(s.detach);
    s.detach = setTimeout(() => kill(s, 'detached too long'), DETACH_MS);
    console.log(`[terminal] detach ${s.id.slice(0, 8)} (kept ${DETACH_MS / 60_000} min)`);
  };
  ws.on('close', gone);
  ws.on('error', gone);
}
