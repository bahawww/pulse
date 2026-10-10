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
 *
 * Wire format: output goes out as binary frames of raw UTF-8 (no JSON escaping,
 * no base64), control messages as JSON text frames. Input comes in as binary
 * frames too; JSON `{type:'input'}` is still accepted from older pages. The
 * browser sends `pause`/`resume` when xterm falls behind, so a flood (`yes`,
 * `cat` of a big log) stops at the pty instead of piling up in the tab.
 *
 * Remote targets: a new shell may ask for `proto=ssh|telnet&host=&port=&user=`.
 * The pty then runs the OpenSSH or telnet client against that host instead of a
 * login shell. In ssh mode it runs through the loopback login, so it uses the
 * user's own ~/.ssh (keys, config, known_hosts) exactly as typing it would. No
 * new privilege: the same person could type the command into a shell. Host,
 * user and port are checked against strict patterns and passed as single
 * arguments, never through a shell string built from raw input.
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

const MAX_SESSIONS = 24;
const IDLE_MS = 60 * 60_000;
/** How long a shell with no browser attached keeps running. */
const DETACH_MS = 15 * 60_000;
/** Recent output kept per shell for replay on reattach. */
const REPLAY_BYTES = 512 * 1024;
/**
 * Output is coalesced for up to this long before it goes out as one frame. A
 * chunk that arrives after a quiet spell (a keystroke echo) goes out on the next
 * tick instead, so typing never waits on the timer.
 */
const FLUSH_MS = 6;
/** Pause the pty when the socket has this much unsent, resume below LOW_WATER. */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 128 * 1024;
const PATH = '/api/terminal';

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/** A remote host this shell connects to instead of a login shell. */
export interface Target {
  readonly proto: 'ssh' | 'telnet';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Allow SHA-1 key exchange, ssh-rsa/ssh-dss host keys and CBC ciphers, for old routers. */
  readonly legacy: boolean;
}

interface Shell {
  readonly id: string;
  readonly login: string;
  readonly pty: pty.IPty;
  readonly started: number;
  readonly target: Target | null;
  ws: WebSocket | null;
  /** Ring of recent output chunks, newest last, at most REPLAY_BYTES in total. */
  replay: string[];
  replaySize: number;
  pending: string;
  flushTimer: NodeJS.Timeout | NodeJS.Immediate | null;
  lastFlush: number;
  idle: NodeJS.Timeout | null;
  detach: NodeJS.Timeout | null;
  /** The socket's send buffer is over HIGH_WATER. */
  paused: boolean;
  /** The browser asked to stop: xterm has more queued than it can draw. */
  held: boolean;
  /** What the pty is actually set to, so pause() and resume() are only called on a change. */
  stopped: boolean;
  cols: number;
  rows: number;
  exited: boolean;
}

const shells = new Map<string, Shell>();

onSessionEnd((hash) => {
  for (const s of [...shells.values()]) if (s.login === hash) kill(s, 'logged out', 4401);
});

type Out =
  | { t: 'hello'; sid: string; resumed: boolean; mode: string; pid: number; bin: true; target: string | null }
  | { t: 'o'; d: string }
  | { t: 'exit'; code: number; signal?: number }
  | { t: 'pong'; ts: number };

// ------------------------------------------------------------------ remote targets

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)*\.?|[0-9A-Fa-f:.]{2,45})$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+-]{0,63}$/;

/** A remote target from the upgrade URL, or null for a login shell. A bad value is an error string. */
export function parseTarget(q: URLSearchParams): Target | null | string {
  const proto = q.get('proto');
  if (!proto) return null;
  if (proto !== 'ssh' && proto !== 'telnet') return 'unknown protocol';
  const host = q.get('host') ?? '';
  if (host.length > 253 || !HOST_RE.test(host)) return 'invalid host';
  const user = q.get('user') ?? '';
  if (user && !USER_RE.test(user)) return 'invalid user name';
  const dflt = proto === 'ssh' ? 22 : 23;
  const rawPort = q.get('port');
  const port = rawPort ? Number(rawPort) : dflt;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid port';
  return { proto, host, port, user, legacy: q.get('legacy') === '1' };
}

const LEGACY_SSH = [
  '-o', 'KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1,diffie-hellman-group-exchange-sha1',
  '-o', 'HostKeyAlgorithms=+ssh-rsa,ssh-dss',
  '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
  '-o', 'Ciphers=+aes128-cbc,aes256-cbc,3des-cbc',
];

/** The client command for a target, as an argv. Every value was checked by parseTarget. */
function targetArgv(t: Target): string[] {
  if (t.proto === 'telnet') return ['telnet', '--', t.host, String(t.port)];
  return [
    'ssh',
    '-p', String(t.port),
    // A router's host key is learnt on first use and checked after that.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ConnectTimeout=10',
    ...(t.legacy ? LEGACY_SSH : []),
    ...(t.user ? ['-l', t.user] : []),
    '--',
    t.host,
  ];
}

export function targetLabel(t: Target): string {
  return `${t.proto} ${t.user ? `${t.user}@` : ''}${t.host}:${t.port}`;
}

/** POSIX single-quoting, for the command the loopback login runs. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

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

function spawnShell(cols: number, rows: number, target: Target | null): pty.IPty | string {
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
    if (target) {
      const [cmd, ...args] = targetArgv(target);
      return pty.spawn(cmd ?? 'ssh', args, opts);
    }
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
      // A remote target runs as the login's own command, in place of its shell.
      ...(target ? [`exec ${targetArgv(target).map(shq).join(' ')}`] : []),
    ],
    opts,
  );
}

/** Pause the pty while the socket or the browser is behind; resume when both have caught up. */
function syncFlow(s: Shell): void {
  const stop = s.paused || s.held;
  if (stop === s.stopped || s.exited) return;
  s.stopped = stop;
  if (stop) s.pty.pause();
  else s.pty.resume();
}

function send(s: Shell, frame: string | Buffer): void {
  const ws = s.ws;
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(frame, { binary: typeof frame !== 'string' }, () => {
    // Flow control: resume a paused pty once the socket has drained.
    if (s.paused && s.ws === ws && ws.bufferedAmount < LOW_WATER) {
      s.paused = false;
      syncFlow(s);
    }
  });
  if (!s.paused && ws.bufferedAmount > HIGH_WATER) {
    s.paused = true;
    syncFlow(s);
  }
}

function emit(s: Shell, msg: Out): void {
  send(s, JSON.stringify(msg));
}

function cancelFlush(s: Shell): void {
  if (!s.flushTimer) return;
  clearTimeout(s.flushTimer as NodeJS.Timeout);
  clearImmediate(s.flushTimer as NodeJS.Immediate);
  s.flushTimer = null;
}

function flush(s: Shell): void {
  s.flushTimer = null;
  if (!s.pending) return;
  const d = s.pending;
  s.pending = '';
  s.lastFlush = Date.now();
  send(s, Buffer.from(d, 'utf8'));
}

function schedule(s: Shell): void {
  if (s.flushTimer) return;
  const since = Date.now() - s.lastFlush;
  s.flushTimer = since >= FLUSH_MS ? setImmediate(flush, s) : setTimeout(flush, FLUSH_MS - since, s);
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
  cancelFlush(s);
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

function create(login: string, cols: number, rows: number, target: Target | null): Shell | string {
  const p = spawnShell(cols, rows, target);
  if (typeof p === 'string') return p;
  const s: Shell = {
    id: randomBytes(16).toString('hex'),
    login,
    pty: p,
    started: Date.now(),
    target,
    ws: null,
    replay: [],
    replaySize: 0,
    pending: '',
    flushTimer: null,
    lastFlush: 0,
    idle: null,
    detach: null,
    paused: false,
    held: false,
    stopped: false,
    cols,
    rows,
    exited: false,
  };
  shells.set(s.id, s);
  touch(s);
  p.onData((d) => {
    remember(s, d);
    s.pending += d;
    schedule(s);
  });
  p.onExit(({ exitCode, signal }) => {
    s.exited = true;
    cancelFlush(s);
    flush(s);
    emit(s, { t: 'exit', code: exitCode, signal });
    kill(s, `shell exited ${exitCode}`);
  });
  console.log(`[terminal] spawn ${s.id.slice(0, 8)} pid=${p.pid} mode=${MODE}${target ? ` -> ${targetLabel(target)}` : ''} (${shells.size} active)`);
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
  const target = resumable ? null : parseTarget(url.searchParams);
  if (typeof target === 'string') return deny('400 Bad Request', target);

  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, login, resumable, cols, rows, target, req.socket.remoteAddress ?? '?'));
}

function attach(ws: WebSocket, login: string, found: Shell | undefined, cols: number, rows: number, target: Target | null, peer: string): void {
  let s: Shell;
  if (found) {
    s = found;
    if (s.detach) clearTimeout(s.detach);
    s.detach = null;
    // One browser view per shell: a second tab takes it over.
    if (s.ws && s.ws !== ws) s.ws.close(4409, 'opened elsewhere');
  } else {
    const made = create(login, cols, rows, target);
    if (typeof made === 'string') {
      ws.send(JSON.stringify({ t: 'o', d: `\r\n\x1b[31m${made}\x1b[0m\r\n` }));
      ws.close(1011, made);
      return;
    }
    s = made;
  }
  s.ws = ws;
  // A new view starts with an empty xterm and a drained socket.
  s.paused = false;
  s.held = false;
  syncFlow(s);
  console.log(`[terminal] ${found ? 'resume' : 'open'} ${s.id.slice(0, 8)} from ${peer}`);

  emit(s, { t: 'hello', sid: s.id, resumed: !!found, mode: MODE, pid: s.pty.pid, bin: true, target: s.target ? targetLabel(s.target) : null });
  if (found) {
    // Pending output is already part of the replay; send it once.
    cancelFlush(s);
    s.pending = '';
    if (s.replaySize > 0) send(s, Buffer.from(s.replay.join(''), 'utf8'));
  }

  ws.on('message', (raw, isBinary) => {
    if (s.ws !== ws) return;
    if (!isValid(login)) {
      kill(s, 'login expired', 4401);
      return;
    }
    // Binary frames are keystrokes and pastes, as UTF-8.
    if (isBinary) {
      touch(s);
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (!s.exited) s.pty.write(buf.toString('utf8'));
      return;
    }
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown; ts?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Pings and flow control keep the link fresh but do not count as activity.
    if (msg.type !== 'ping' && msg.type !== 'pause' && msg.type !== 'resume') touch(s);
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
    } else if (msg.type === 'pause' || msg.type === 'resume') {
      s.held = msg.type === 'pause';
      syncFlow(s);
    } else if (msg.type === 'ping' && typeof msg.ts === 'number') {
      emit(s, { t: 'pong', ts: msg.ts });
    } else if (msg.type === 'kill') {
      kill(s, 'closed by user');
    }
  });

  const gone = (): void => {
    if (s.ws !== ws) return;
    s.ws = null;
    // Nobody is drawing: keep the shell running and let the replay ring absorb output.
    s.paused = false;
    s.held = false;
    syncFlow(s);
    if (!shells.has(s.id)) return;
    if (s.detach) clearTimeout(s.detach);
    s.detach = setTimeout(() => kill(s, 'detached too long'), DETACH_MS);
    console.log(`[terminal] detach ${s.id.slice(0, 8)} (kept ${DETACH_MS / 60_000} min)`);
  };
  ws.on('close', gone);
  ws.on('error', gone);
}
