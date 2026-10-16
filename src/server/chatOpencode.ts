import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ChatEvent,
  ChatHistory,
  ChatMessage,
  ChatMessageInfo,
  ChatModelRef,
  ChatPart,
  ChatPermission,
  ChatProviderList,
  ChatSession,
  ChatUpstream,
} from '../shared/contract.js';
import { ChatError, type ChatAdapter } from './chatAdapter.js';

/**
 * The OpenCode adapter: the `opencode web` server on 127.0.0.1:4096
 * (user unit opencode-web.service). OpenCode keeps the sessions; this only
 * translates its HTTP API and event stream into the chat contract.
 *
 *  - Basic auth from ~/.config/opencode/web.env (OPENCODE_SERVER_PASSWORD,
 *    OPENCODE_SERVER_USERNAME, default user "opencode"), read here and never
 *    passed on. Re-read when the file changes.
 *  - OpenCode runs one instance per directory: /event only carries the
 *    events of one directory, so this follows /global/event (all of them),
 *    one connection for every browser.
 *  - Sessions made here run in CHAT_DIRECTORY (default: the home directory) and ask
 *    before every shell command and file edit (ASK_RULES). Sessions made in
 *    the OpenCode web UI keep their own rules.
 */

const BASE = (process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/+$/, '');
const ENV_FILE = process.env.OPENCODE_ENV_FILE ?? path.join(os.homedir(), '.config', 'opencode', 'web.env');
/** Where sessions made in Pulse run: the dashboard user's home (/home/bahar) unless set. */
export const CHAT_DIRECTORY = process.env.CHAT_DIRECTORY || os.homedir();
const ASK_RULES = [
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'edit', pattern: '*', action: 'ask' },
] as const;

const REQUEST_TIMEOUT_MS = 15_000;
/** OpenCode sends a heartbeat about every 10 s; silence this long means a dead stream. */
const STREAM_IDLE_MS = 45_000;
const PROVIDERS_TTL_MS = 5 * 60_000;
const HISTORY_LIMIT = 300;

// Tool calls can carry whole files. Cut what goes to the browser.
const INPUT_MAX = 4_000;
const OUTPUT_HEAD = 8_000;
const OUTPUT_TAIL = 16_000;
const DIFF_MAX = 64_000;
const SHELL_NOTE = /\s*<shell_metadata>([\s\S]*?)<\/shell_metadata>\s*/g;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface Creds {
  readonly header: string;
}

let credCache: { mtimeMs: number; creds: Creds | null } | null = null;

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function basic(user: string, pass: string): Creds {
  return { header: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

function credentials(): Creds | null {
  const envPass = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPass) return basic(process.env.OPENCODE_SERVER_USERNAME || 'opencode', envPass);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(ENV_FILE).mtimeMs;
  } catch {
    credCache = null;
    return null;
  }
  if (credCache?.mtimeMs === mtimeMs) return credCache.creds;
  let creds: Creds | null = null;
  try {
    const env = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
    if (env.OPENCODE_SERVER_PASSWORD) creds = basic(env.OPENCODE_SERVER_USERNAME || 'opencode', env.OPENCODE_SERVER_PASSWORD);
  } catch (err) {
    console.warn('[chat] cannot read', ENV_FILE, err instanceof Error ? err.message : err);
  }
  credCache = { mtimeMs, creds };
  return creds;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Null until the first answer or failure: a stream opened before that gets no state. */
let upstream: ChatUpstream | null = null;
let emit: (e: ChatEvent) => void = () => undefined;

function setUpstream(next: ChatUpstream): void {
  if (next === upstream) return;
  upstream = next;
  emit({ type: 'upstream', status: next });
}

function url(route: string, query: Readonly<Record<string, string | undefined>> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
  const s = qs.toString();
  return `${BASE}${route}${s ? `?${s}` : ''}`;
}

/** Error text OpenCode put in a failed answer, without anything that echoes headers. */
function upstreamMessage(body: unknown, status: number): string {
  const b = body as { data?: { message?: unknown }; message?: unknown; error?: unknown } | null;
  const msg = b?.data?.message ?? b?.message ?? (typeof b?.error === 'string' ? b.error : undefined);
  return typeof msg === 'string' && msg ? msg.slice(0, 300) : `OpenCode answered ${status}`;
}

async function call<T>(method: string, route: string, query?: Readonly<Record<string, string | undefined>>, body?: unknown): Promise<T> {
  const creds = credentials();
  if (!creds) {
    setUpstream('unconfigured');
    throw new ChatError(503, 'OpenCode credentials not found on the server');
  }
  let res: Response;
  try {
    res = await fetch(url(route, query), {
      method,
      headers: {
        Authorization: creds.header,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A slow answer says nothing about the server being down; only a refused connection does.
    if (err instanceof Error && err.name === 'TimeoutError') throw new ChatError(504, 'OpenCode did not answer in time');
    setUpstream('down');
    throw new ChatError(503, 'OpenCode is not reachable');
  }
  if (res.status === 401) {
    setUpstream('auth');
    throw new ChatError(502, 'OpenCode refused the credentials');
  }
  // Any other answer means it is up and the login works.
  setUpstream('up');
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw new ChatError(res.status === 404 ? 404 : res.status === 400 ? 400 : 502, upstreamMessage(parsed, res.status));
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/* The OpenCode shapes this reads (from its /doc). Only the fields used. */
interface OcSession {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  model?: { id: string; providerID: string };
  time: { created: number; updated: number; archived?: number };
}
interface OcMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  model?: { providerID: string; modelID: string };
  providerID?: string;
  modelID?: string;
  error?: { name?: string; data?: { message?: string } };
}
interface OcToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}
interface OcPart {
  id: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  callID?: string;
  state?: OcToolState;
  filename?: string;
  mime?: string;
}
interface OcPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
}
type OcStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; message: string };

/** Session id to the directory its OpenCode instance runs in. */
const directories = new Map<string, string>();
const busy = new Map<string, boolean>();

function toSession(s: OcSession): ChatSession {
  directories.set(s.id, s.directory);
  return {
    id: s.id,
    agent: 'opencode',
    title: s.title,
    directory: s.directory,
    createdAt: s.time.created,
    updatedAt: s.time.updated,
    busy: busy.get(s.id) ?? false,
    model: s.model ? { providerID: s.model.providerID, modelID: s.model.id } : null,
  };
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… ${s.length - max} more characters`;
}

/** Head and tail of a long output: the end of a build log matters most. */
function cutMiddle(s: string): string {
  if (s.length <= OUTPUT_HEAD + OUTPUT_TAIL) return s;
  return `${s.slice(0, OUTPUT_HEAD)}\n… ${s.length - OUTPUT_HEAD - OUTPUT_TAIL} characters left out …\n${s.slice(-OUTPUT_TAIL)}`;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

function toPart(p: OcPart): ChatPart | null {
  switch (p.type) {
    case 'text':
      if (p.synthetic || p.ignored) return null;
      return { type: 'text', id: p.id, text: p.text ?? '' };
    case 'reasoning':
      return { type: 'reasoning', id: p.id, text: p.text ?? '' };
    case 'file':
      return { type: 'file', id: p.id, filename: p.filename ?? 'file', mime: p.mime ?? '' };
    case 'tool': {
      const st = p.state ?? { status: 'pending' };
      const input = st.input ?? {};
      const meta = st.metadata ?? {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) fields[k] = cut(asText(v), INPUT_MAX);
      const first = [input.command, input.filePath, input.path, input.url, input.pattern, input.description].find((v) => typeof v === 'string' && v);
      // A running shell streams its output into metadata.output.
      const raw = st.status === 'completed' ? (st.output ?? '') : typeof meta.output === 'string' ? meta.output : '';
      // The shell tool appends notes in <shell_metadata>; a stopped command still counts as "completed".
      const notes = [...raw.matchAll(SHELL_NOTE)].map((m) => m[1]!.trim());
      const output = raw.replace(SHELL_NOTE, '').replace(/^\(no output\)\s*$/, '').trimEnd();
      const stopped = notes.some((n) => /aborted/i.test(n));
      return {
        type: 'tool',
        id: p.id,
        callID: p.callID ?? '',
        tool: p.tool ?? 'tool',
        status: stopped ? 'error' : st.status,
        title: cut(String(st.title || first || p.tool || 'tool'), 300),
        input: fields,
        output: cutMiddle([output, ...notes.filter((n) => !/aborted/i.test(n))].filter(Boolean).join('\n\n')),
        error: stopped ? 'Stopped' : st.status === 'error' ? cut(st.error ?? 'failed', 4_000) : '',
        diff: typeof meta.diff === 'string' ? cut(meta.diff, DIFF_MAX) : '',
      };
    }
    default:
      return null;
  }
}

function errorText(e: OcMessage['error']): string {
  if (!e) return '';
  if (e.name === 'MessageAbortedError') return 'Stopped';
  return cut(e.data?.message || e.name || 'failed', 600);
}

function toInfo(m: OcMessage): ChatMessageInfo {
  const model: ChatModelRef | null = m.model
    ? { providerID: m.model.providerID, modelID: m.model.modelID }
    : m.providerID && m.modelID
      ? { providerID: m.providerID, modelID: m.modelID }
      : null;
  return {
    id: m.id,
    sessionID: m.sessionID,
    role: m.role,
    createdAt: m.time.created,
    completedAt: m.time.completed ?? null,
    model,
    error: errorText(m.error),
  };
}

function toPermission(p: OcPermission): ChatPermission {
  return {
    id: p.id,
    sessionID: p.sessionID,
    kind: p.permission,
    patterns: (p.patterns ?? []).map((s) => cut(s, 2_000)),
    always: (p.always ?? []).map((s) => cut(s, 300)),
    callID: p.tool?.callID ?? '',
    diff: typeof p.metadata?.diff === 'string' ? cut(p.metadata.diff, DIFF_MAX) : '',
  };
}

function isBusy(s: OcStatus | undefined): boolean {
  return !!s && s.type !== 'idle';
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

interface Wrapped {
  directory?: string;
  payload?: { type?: string; properties?: Record<string, unknown> };
}

function handle(w: Wrapped): void {
  const type = w.payload?.type;
  const p = (w.payload?.properties ?? {}) as Record<string, unknown> & { sessionID?: string };
  const sid = typeof p.sessionID === 'string' ? p.sessionID : '';
  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const info = p.info as OcSession | undefined;
      if (!info || info.parentID || info.time.archived) return;
      emit({ type: 'session', session: toSession(info) });
      return;
    }
    case 'session.deleted':
      directories.delete(sid);
      busy.delete(sid);
      emit({ type: 'session.deleted', sessionID: sid });
      return;
    case 'session.status': {
      const st = p.status as OcStatus | undefined;
      busy.set(sid, isBusy(st));
      emit({ type: 'status', sessionID: sid, busy: isBusy(st), retry: st?.type === 'retry' ? cut(st.message, 300) : '' });
      return;
    }
    case 'session.idle':
      busy.set(sid, false);
      emit({ type: 'status', sessionID: sid, busy: false, retry: '' });
      return;
    case 'session.error': {
      if (!sid) return;
      const message = errorText(p.error as OcMessage['error']);
      if (message && message !== 'Stopped') emit({ type: 'error', sessionID: sid, message });
      return;
    }
    case 'message.updated': {
      const info = p.info as OcMessage | undefined;
      if (info) emit({ type: 'message', sessionID: info.sessionID, message: toInfo(info) });
      return;
    }
    case 'message.removed':
      emit({ type: 'message.removed', sessionID: sid, messageID: String(p.messageID ?? '') });
      return;
    case 'message.part.updated': {
      const raw = p.part as (OcPart & { messageID: string; sessionID: string }) | undefined;
      const part = raw ? toPart(raw) : null;
      if (raw && part) emit({ type: 'part', sessionID: raw.sessionID, messageID: raw.messageID, part });
      return;
    }
    case 'message.part.removed':
      emit({ type: 'part.removed', sessionID: sid, messageID: String(p.messageID ?? ''), partID: String(p.partID ?? '') });
      return;
    case 'message.part.delta':
      if (p.field !== 'text' || typeof p.delta !== 'string') return;
      emit({ type: 'delta', sessionID: sid, messageID: String(p.messageID ?? ''), partID: String(p.partID ?? ''), delta: p.delta });
      return;
    case 'permission.asked':
      emit({ type: 'permission', permission: toPermission(p as unknown as OcPermission) });
      return;
    case 'permission.replied':
      emit({ type: 'permission.replied', sessionID: sid, id: String(p.requestID ?? '') });
      return;
    default:
  }
}

let running = false;
let abortStream: AbortController | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

async function follow(creds: Creds): Promise<void> {
  const ctrl = new AbortController();
  abortStream = ctrl;
  let idle: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS);
    idle.unref();
  };
  kick();
  try {
    const res = await fetch(`${BASE}/global/event`, { headers: { Authorization: creds.header, Accept: 'text/event-stream' }, signal: ctrl.signal });
    if (res.status === 401) {
      await res.body?.cancel();
      setUpstream('auth');
      return;
    }
    if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
    setUpstream('up');
    const decoder = new TextDecoder();
    let buf = '';
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      buf += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        if (upstream !== 'up') setUpstream('up');
        try {
          handle(JSON.parse(data) as Wrapped);
        } catch (err) {
          console.warn('[chat] bad upstream event:', err instanceof Error ? err.message : err);
        }
      }
    }
    setUpstream('down');
  } catch {
    if (running) setUpstream('down');
  } finally {
    clearTimeout(idle);
    abortStream = null;
  }
}

async function loop(): Promise<void> {
  let backoff = 1_000;
  while (running) {
    const creds = credentials();
    if (!creds) {
      setUpstream('unconfigured');
      await sleep(30_000);
      continue;
    }
    const started = Date.now();
    await follow(creds);
    if (!running) return;
    // A stream that stayed up a while resets the backoff.
    backoff = Date.now() - started > 30_000 ? 1_000 : Math.min(backoff * 2, upstream === 'auth' ? 60_000 : 15_000);
    await sleep(backoff);
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

async function directoryOf(id: string): Promise<string> {
  const known = directories.get(id);
  if (known) return known;
  const s = await call<OcSession>('GET', `/session/${id}`);
  directories.set(id, s.directory);
  return s.directory;
}

async function statuses(directory: string): Promise<Record<string, OcStatus>> {
  const all = await call<Record<string, OcStatus>>('GET', '/session/status', { directory }).catch(() => ({}));
  for (const [id, st] of Object.entries(all)) busy.set(id, isBusy(st));
  return all;
}

let providerCache: { at: number; list: ChatProviderList } | null = null;

export const opencode: ChatAdapter = {
  agent: 'opencode',
  directory: CHAT_DIRECTORY,

  status: () => upstream,

  async probe() {
    try {
      await call('GET', '/session/status', { directory: CHAT_DIRECTORY });
    } catch {
      /* call() set the state */
    }
    return upstream ?? 'down';
  },

  start(sink) {
    emit = sink;
    if (running) return;
    running = true;
    void loop();
  },

  stop() {
    running = false;
    abortStream?.abort();
  },

  async listSessions() {
    let raw: OcSession[];
    try {
      raw = await call<OcSession[]>('GET', '/experimental/session', { roots: 'true', limit: '200' });
    } catch (err) {
      if (!(err instanceof ChatError) || err.status !== 404) throw err;
      // Older servers: no cross-directory list. The default and the chat directory then.
      const [a, b] = await Promise.all([call<OcSession[]>('GET', '/session'), call<OcSession[]>('GET', '/session', { directory: CHAT_DIRECTORY })]);
      const seen = new Set<string>();
      raw = [...a, ...b].filter((s) => !seen.has(s.id) && !!seen.add(s.id));
    }
    raw = raw.filter((s) => !s.parentID && !s.time.archived);
    const dirs = [...new Set(raw.map((s) => s.directory))].slice(0, 12);
    await Promise.all(dirs.map(statuses));
    return raw.map(toSession).sort((x, y) => y.updatedAt - x.updatedAt);
  },

  async createSession(title) {
    const s = await call<OcSession>('POST', '/session', { directory: CHAT_DIRECTORY }, { ...(title ? { title } : {}), permission: ASK_RULES });
    return toSession(s);
  },

  async history(id) {
    const s = await call<OcSession>('GET', `/session/${id}`);
    directories.set(id, s.directory);
    const [raw, perms] = await Promise.all([
      call<{ info: OcMessage; parts: OcPart[] }[]>('GET', `/session/${id}/message`, { limit: String(HISTORY_LIMIT) }),
      call<OcPermission[]>('GET', '/permission', { directory: s.directory }),
      statuses(s.directory),
    ]);
    const messages: ChatMessage[] = raw.map((m) => ({
      ...toInfo(m.info),
      parts: m.parts.map(toPart).filter((p): p is ChatPart => p !== null),
    }));
    const history: ChatHistory = {
      session: toSession(s),
      messages,
      permissions: perms.filter((p) => p.sessionID === id).map(toPermission),
    };
    return history;
  },

  async rename(id, title) {
    return toSession(await call<OcSession>('PATCH', `/session/${id}`, { directory: await directoryOf(id) }, { title }));
  },

  async remove(id) {
    await call('DELETE', `/session/${id}`, { directory: await directoryOf(id) });
    directories.delete(id);
  },

  async prompt(id, text, model) {
    await call('POST', `/session/${id}/prompt_async`, { directory: await directoryOf(id) }, {
      parts: [{ type: 'text', text }],
      ...(model ? { model } : {}),
    });
  },

  async abort(id) {
    await call('POST', `/session/${id}/abort`, { directory: await directoryOf(id) });
  },

  async reply(id, requestID, reply) {
    const directory = await directoryOf(id);
    const pending = await call<OcPermission[]>('GET', '/permission', { directory });
    // Only a request of this session: the id alone could answer another session's.
    if (!pending.some((p) => p.id === requestID && p.sessionID === id)) throw new ChatError(404, 'that request was already answered');
    await call('POST', `/permission/${requestID}/reply`, { directory }, { reply });
  },

  async providers() {
    if (providerCache && Date.now() - providerCache.at < PROVIDERS_TTL_MS) return providerCache.list;
    const raw = await call<{ providers: { id: string; name: string; models: Record<string, { id: string; name?: string }> }[]; default: Record<string, string> }>(
      'GET',
      '/config/providers',
      { directory: CHAT_DIRECTORY },
    );
    const list: ChatProviderList = {
      providers: raw.providers.map((p) => ({
        id: p.id,
        name: p.name,
        models: Object.values(p.models)
          .map((m) => ({ id: m.id, name: m.name || m.id }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })),
      defaults: raw.default,
    };
    providerCache = { at: Date.now(), list };
    return list;
  },
};
