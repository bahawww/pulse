import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, RequestHandler, Response } from 'express';

import type { FileEntry, FileKind, FileListing, FilePreview } from '../shared/contract.js';
import { recordAction } from './store.js';
import { DATA_DIR, HOME, LOOPBACK_DEST, MODE, SSH_KEY, loopbackOptions, shq, writeKnownHosts } from './sshLocal.js';

/**
 * File explorer: list, preview, download, upload, new folder, rename, delete.
 *
 * Every operation is a short shell command run through the loopback SSH login
 * (sshLocal.ts), so it acts as the SSH user, outside this service's sandbox,
 * with that user's own permissions and no sudo. Paths reach the shell only
 * single-quoted (shq), after being checked as absolute and normalised.
 *
 * One SSH handshake costs ~300ms, too slow to click through folders, so a
 * master connection is kept open (ControlMaster) while the explorer is in use
 * and closed after MASTER_IDLE_MS. Commands use it when its socket exists and
 * connect on their own otherwise.
 *
 * Writes (upload, new folder, rename, delete) go to the action log.
 */

const MAX_ENTRIES = 5000;
const PREVIEW_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = Number(process.env.FILES_MAX_UPLOAD_MB ?? 2048) * 1024 * 1024;
const CMD_TIMEOUT_MS = 20_000;
/** Moving across filesystems or copying a big folder takes far longer than a listing. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MASTER_IDLE_MS = 5 * 60_000;
const CONTROL_PATH = path.join(DATA_DIR, 'ssh-files.sock');
/** sun_path is 108 bytes and ssh appends a 17-byte temp suffix while binding. */
const MUX = CONTROL_PATH.length <= 90;

/** Exit codes the commands below use for their own refusals. */
const EXIT_MISSING = 3;
const EXIT_EXISTS = 4;
const EXIT_INCOMPLETE = 5;

/**
 * An HTML file opened as a page (view=1), e.g. a generated report. Its scripts
 * run, but CSP sandbox without allow-same-origin gives it an opaque origin: it
 * cannot read this dashboard's storage or DOM, and its requests here are
 * cross-site, so the SameSite=Strict session cookie never goes with them.
 * shortcut: one file only, relative links (./style.css) do not load; a
 * signed per-folder URL would be needed for multi-file sites.
 */
const PAGE_EXT = /^html?$/;
const PAGE_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";

/** Inline previews: raster images only. SVG can carry script, so it downloads. */
const INLINE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

let master: ChildProcessWithoutNullStreams | null = null;
let masterIdle: ReturnType<typeof setTimeout> | undefined;

/** Opens (or keeps open) the shared connection. Commands never wait for it. */
function touchMaster(): void {
  clearTimeout(masterIdle);
  masterIdle = setTimeout(() => master?.kill(), MASTER_IDLE_MS);
  masterIdle.unref();
  if (master) return;
  // A socket left by a killed master would make the new one refuse to listen.
  fs.rmSync(CONTROL_PATH, { force: true });
  const child = spawn(
    '/usr/bin/ssh',
    [...loopbackOptions(), '-N', '-o', 'ControlMaster=yes', '-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ServerAliveInterval=30', LOOPBACK_DEST],
    { stdio: 'pipe' },
  );
  child.stdin.end();
  child.stdout.resume();
  child.stderr.resume();
  child.on('error', () => undefined);
  child.on('close', () => {
    if (master === child) master = null;
  });
  master = child;
}

/** Spawns one command as the SSH user. */
function spawnRemote(cmd: string): ChildProcessWithoutNullStreams | string {
  if (MODE === 'local') return spawn('/bin/sh', ['-c', cmd], { cwd: HOME, stdio: 'pipe' });
  if (!fs.existsSync(SSH_KEY)) return 'file explorer key missing (same key as the terminal)';
  if (!writeKnownHosts()) return 'cannot read host key for pinning';
  if (MUX) touchMaster();
  return spawn(
    '/usr/bin/ssh',
    [...loopbackOptions(), '-T', ...(MUX ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${CONTROL_PATH}`] : []), LOOPBACK_DEST, cmd],
    { stdio: 'pipe' },
  );
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Runs one command as the SSH user over the loopback login (outside this sandbox), to completion. */
export function runRemote(cmd: string, maxBytes = 16 * 1024 * 1024, timeoutMs = CMD_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnRemote(cmd);
    if (typeof child === 'string') {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: child });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) child.kill('SIGKILL');
      else chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
    child.stdin.end();
  });
}

/** The last meaningful stderr line, without the shell's "bash: line 1:" noise. */
function errorText(stderr: string, fallback: string): string {
  const line = stderr
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
    ?.replace(/^(?:\S*sh: )?(?:line \d+: )?/, '')
    .trim();
  return line ? line.slice(0, 300) : fallback;
}

function fail(res: Response, r: RunResult, fallback: string): void {
  const message = errorText(r.stderr, fallback);
  const status =
    r.code === EXIT_MISSING || /No such file/i.test(message)
      ? 404
      : r.code === EXIT_EXISTS
        ? 409
        : /Permission denied|Operation not permitted/i.test(message)
          ? 403
          : r.code === -1
            ? 503
            : 400;
  res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

/** Absolute, normalised, no trailing slash; null for anything else. */
export function cleanPath(input: unknown): string | null {
  if (typeof input !== 'string' || !input.startsWith('/') || input.length > 4096 || input.includes('\0')) return null;
  const p = path.posix.normalize(input);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** One path segment: no slash, not . or .., at most 255 bytes. */
function cleanName(input: unknown): string | null {
  if (typeof input !== 'string' || input.includes('/') || input.includes('\0')) return null;
  if (input === '' || input === '.' || input === '..' || Buffer.byteLength(input) > 255) return null;
  return input;
}

/**
 * Never deleted or renamed here: the root, top-level folders, the home folder,
 * this dashboard's own folder, and anything that contains one of them.
 */
export function isProtected(p: string): boolean {
  if (p === '/' || path.posix.dirname(p) === '/') return true;
  return [HOME, process.cwd()].some((keep) => keep === p || keep.startsWith(`${p}/`));
}

function audit(action: string, name: string, started: number, r: RunResult | null, message?: string): void {
  const ok = r !== null && r.code === 0;
  recordAction({
    ts: Date.now(),
    target: 'files',
    name: name.slice(0, 500),
    action,
    ok,
    message: message ?? (ok ? 'done' : errorText(r?.stderr ?? '', 'failed')),
    durationMs: Date.now() - started,
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function kindOf(c: string): FileKind {
  return c === 'f' ? 'file' : c === 'd' ? 'dir' : c === 'l' ? 'link' : 'other';
}

async function list(req: Request, res: Response): Promise<void> {
  const raw = req.query.path;
  const dir = raw === undefined || raw === '' ? null : cleanPath(raw);
  if (raw !== undefined && raw !== '' && !dir) {
    res.status(400).json({ error: 'path must be absolute' });
    return;
  }
  const cmd =
    `cd ${dir ? `-- ${shq(dir)}` : ''} && pwd && printf '%s\\n' "$HOME" && ` +
    `LC_ALL=C find . -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\t%f\\0' 2>/dev/null | head -z -n ${MAX_ENTRIES + 1}`;
  const r = await runRemote(cmd);
  if (r.code !== 0 && r.stdout.length === 0) {
    fail(res, r, 'cannot open folder');
    return;
  }
  const out = r.stdout.toString('utf8');
  const nl1 = out.indexOf('\n');
  const nl2 = out.indexOf('\n', nl1 + 1);
  const records = out.slice(nl2 + 1).split('\0').filter(Boolean);
  const entries: FileEntry[] = records.slice(0, MAX_ENTRIES).map((rec) => {
    const [y = '', ty = '', size = '0', mtime = '0', mode = '', owner = '', ...name] = rec.split('\t');
    const kind = kindOf(y);
    return {
      name: name.join('\t'),
      kind,
      target: kind === 'link' ? kindOf(ty) : null,
      size: Number(size) || 0,
      mtime: Math.round(Number(mtime) * 1000) || 0,
      mode,
      owner,
    };
  });
  const listing: FileListing = {
    path: out.slice(0, nl1),
    home: out.slice(nl1 + 1, nl2),
    entries,
    truncated: records.length > MAX_ENTRIES,
  };
  res.json(listing);
}

async function preview(req: Request, res: Response): Promise<void> {
  const file = cleanPath(req.query.path);
  if (!file) {
    res.status(400).json({ error: 'path must be absolute' });
    return;
  }
  const q = shq(file);
  const r = await runRemote(
    `[ -f ${q} ] || { echo 'not a regular file' >&2; exit ${EXIT_MISSING}; }; stat -c %s -- ${q} && head -c ${PREVIEW_BYTES} -- ${q}`,
    PREVIEW_BYTES + 64,
  );
  if (r.code !== 0) {
    fail(res, r, 'cannot read file');
    return;
  }
  const nl = r.stdout.indexOf(10);
  const size = Number(r.stdout.subarray(0, nl).toString()) || 0;
  const body = r.stdout.subarray(nl + 1);
  const binary = body.includes(0);
  const result: FilePreview = {
    path: file,
    size,
    text: binary ? null : new TextDecoder('utf-8').decode(body),
    truncated: size > body.length,
  };
  res.json(result);
}

async function download(req: Request, res: Response): Promise<void> {
  const file = cleanPath(req.query.path);
  if (!file) {
    res.status(400).json({ error: 'path must be absolute' });
    return;
  }
  const q = shq(file);
  const head = await runRemote(`[ -f ${q} ] || { echo 'not a regular file' >&2; exit ${EXIT_MISSING}; }; [ -r ${q} ] || { echo 'Permission denied' >&2; exit 1; }; stat -c %s -- ${q}`);
  if (head.code !== 0) {
    fail(res, head, 'cannot read file');
    return;
  }
  const size = Number(head.stdout.toString().trim()) || 0;
  const name = path.posix.basename(file);
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const page = req.query.view === '1' && PAGE_EXT.test(ext);
  const inline = page ? 'text/html; charset=utf-8' : req.query.inline === '1' ? INLINE_TYPES[ext] : undefined;

  // Capped at the size just read, so a growing log never overruns Content-Length.
  const child = spawnRemote(`head -c ${size} -- ${q}`);
  if (typeof child === 'string') {
    res.status(503).json({ error: child });
    return;
  }
  child.stdin.end();
  res.setHeader('Content-Type', inline ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Security-Policy', page ? PAGE_CSP : "default-src 'none'; sandbox");
  // Browsers refuse to load a sandboxed page that also asks for COOP isolation.
  if (page) res.removeHeader('Cross-Origin-Opener-Policy');
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);

  let sent = 0;
  child.stdout.on('data', (c: Buffer) => {
    sent += c.length;
  });
  child.stdout.pipe(res);
  child.stderr.resume();
  res.on('close', () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  child.on('close', () => {
    // Shrank or failed midway: break the response so the browser reports it.
    if (sent !== size) res.destroy();
  });
}

async function upload(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const dir = cleanPath(req.query.dir);
  const name = cleanName(req.query.name);
  const overwrite = req.query.overwrite === '1';
  const length = Number(req.headers['content-length']);
  if (!dir || !name) {
    res.status(400).json({ error: 'dir and name required' });
    return;
  }
  if (!Number.isFinite(length) || length < 0) {
    res.status(411).json({ error: 'Content-Length required' });
    return;
  }
  if (length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit` });
    return;
  }
  const target = path.posix.join(dir, name);
  const qd = shq(dir);
  const qt = shq(target);
  const check =
    `[ -d ${qd} ] || { echo 'not a folder' >&2; exit ${EXIT_MISSING}; }; ` +
    (overwrite ? '' : `[ -e ${qt} ] && { echo 'already exists' >&2; exit ${EXIT_EXISTS}; }; `) +
    `[ -w ${qd} ] || { echo 'Permission denied' >&2; exit 1; }; true`;

  // Refuse before reading a byte of the body.
  const pre = await runRemote(check);
  if (pre.code !== 0) {
    req.resume();
    fail(res, pre, 'cannot upload here');
    return;
  }

  // Written to a temp file beside the target and moved into place only when
  // every byte arrived, so an aborted upload never leaves half a file.
  const cmd =
    `${check}; t=$(mktemp ${shq(`${dir}/.upload.XXXXXX`)}) || exit 1; trap 'rm -f "$t"' EXIT HUP INT TERM; ` +
    `cat > "$t"; n=$(wc -c < "$t"); [ "$n" -eq ${length} ] || { echo 'upload incomplete' >&2; exit ${EXIT_INCOMPLETE}; }; ` +
    // -T: a folder with the file's name is an error, not a place to move the temp file into.
    `chmod "$(printf %o $((0666 & ~0$(umask))))" "$t" && mv -fT -- "$t" ${qt}`;
  const child = spawnRemote(cmd);
  if (typeof child === 'string') {
    req.resume();
    res.status(503).json({ error: child });
    return;
  }
  let stderr = '';
  let received = 0;
  // Not req.destroyed: Node sets that once the body is fully read, too.
  let aborted = false;
  child.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 4096) stderr += c.toString('utf8');
  });
  child.stdout.resume();
  child.stdin.on('error', () => undefined);
  req.on('data', (c: Buffer) => {
    received += c.length;
    if (received > length) child.kill('SIGKILL');
  });
  req.on('aborted', () => {
    aborted = true;
    child.kill('SIGKILL');
  });
  req.pipe(child.stdin);
  child.on('error', () => undefined);
  child.on('close', (code) => {
    const r: RunResult = { code, stdout: Buffer.alloc(0), stderr };
    audit('upload', target, started, r, code === 0 ? `${length} bytes` : undefined);
    if (res.headersSent || aborted) return;
    if (code === 0) res.json({ ok: true, path: target });
    else {
      req.unpipe(child.stdin);
      req.resume();
      fail(res, r, 'upload failed');
    }
  });
}

async function mkdir(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const body = req.body as { dir?: unknown; name?: unknown };
  const dir = cleanPath(body.dir);
  const name = cleanName(body.name);
  if (!dir || !name) {
    res.status(400).json({ error: 'dir and name required' });
    return;
  }
  const target = path.posix.join(dir, name);
  const r = await runRemote(`mkdir -- ${shq(target)}`);
  audit('mkdir', target, started, r);
  if (r.code === 0) res.json({ ok: true, path: target });
  else fail(res, r, 'cannot create folder');
}

async function rename(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const body = req.body as { path?: unknown; name?: unknown };
  const from = cleanPath(body.path);
  const name = cleanName(body.name);
  if (!from || !name) {
    res.status(400).json({ error: 'path and name required' });
    return;
  }
  if (isProtected(from)) {
    res.status(403).json({ error: 'this folder cannot be renamed here' });
    return;
  }
  const to = path.posix.join(path.posix.dirname(from), name);
  const r = await runRemote(
    `[ -e ${shq(to)} ] && { echo 'a file with that name already exists' >&2; exit ${EXIT_EXISTS}; }; mv -- ${shq(from)} ${shq(to)}`,
  );
  audit('rename', `${from} -> ${name}`, started, r);
  if (r.code === 0) res.json({ ok: true, path: to });
  else fail(res, r, 'cannot rename');
}

async function remove(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const target = cleanPath((req.body as { path?: unknown }).path);
  if (!target) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  if (isProtected(target)) {
    res.status(403).json({ error: 'this folder cannot be deleted here' });
    return;
  }
  const r = await runRemote(`[ -e ${shq(target)} ] || [ -L ${shq(target)} ] || { echo 'No such file' >&2; exit ${EXIT_MISSING}; }; rm -rf -- ${shq(target)}`);
  audit('delete', target, started, r);
  if (r.code === 0) res.json({ ok: true });
  else fail(res, r, 'cannot delete');
}

/**
 * Why `from` cannot go into folder `dest`, or null when it can. A move takes
 * the item away, so protected folders stay; a copy may read anything.
 */
export function transferRefusal(from: string, dest: string, copy: boolean): { status: number; error: string } | null {
  if (!copy && isProtected(from)) return { status: 403, error: 'this folder cannot be moved here' };
  if (dest === from || dest.startsWith(`${from}/`)) return { status: 400, error: 'a folder cannot go inside itself' };
  if (path.posix.dirname(from) === dest) return { status: 409, error: 'it is already in that folder' };
  return null;
}

async function transfer(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const body = req.body as { path?: unknown; dest?: unknown; copy?: unknown };
  const from = cleanPath(body.path);
  const dest = cleanPath(body.dest);
  const copy = body.copy === true;
  if (!from || !dest) {
    res.status(400).json({ error: 'path and dest required' });
    return;
  }
  const refused = transferRefusal(from, dest, copy);
  if (refused) {
    res.status(refused.status).json({ error: refused.error });
    return;
  }
  const to = path.posix.join(dest, path.posix.basename(from));
  const r = await runRemote(
    `[ -d ${shq(dest)} ] || { echo 'No such folder' >&2; exit ${EXIT_MISSING}; }; ` +
      `[ -e ${shq(to)} ] || [ -L ${shq(to)} ] && { echo 'a file with that name already exists there' >&2; exit ${EXIT_EXISTS}; }; ` +
      `${copy ? 'cp -a' : 'mv'} -- ${shq(from)} ${shq(to)}`,
    64 * 1024,
    TRANSFER_TIMEOUT_MS,
  );
  audit(copy ? 'copy' : 'move', `${from} -> ${dest}`, started, r);
  if (r.code === 0) res.json({ ok: true, path: to });
  else fail(res, r, copy ? 'cannot copy' : 'cannot move');
}

/** Async handlers whose rejections still answer, instead of leaving the request open. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : 'failed' });
    });
  };
}

export function registerFileRoutes(app: Express, read: RequestHandler, write: RequestHandler): void {
  app.get('/api/files/list', read, wrap(list));
  app.get('/api/files/preview', read, wrap(preview));
  app.get('/api/files/download', read, wrap(download));
  app.post('/api/files/upload', write, wrap(upload));
  app.post('/api/files/mkdir', write, wrap(mkdir));
  app.post('/api/files/rename', write, wrap(rename));
  app.post('/api/files/delete', write, wrap(remove));
  app.post('/api/files/move', write, wrap(transfer));
}

/** The upload body is the raw file, not JSON; the CSRF gate lets this one path through. */
export const UPLOAD_PATH = '/files/upload';
