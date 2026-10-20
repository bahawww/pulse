import type { Express, Request, RequestHandler, Response } from 'express';

import { chatEventSession, type ChatAttachment, type ChatEvent, type ChatMention, type ChatModelRef } from '../shared/contract.js';
import { ChatError, type ChatAdapter } from './chatAdapter.js';
import { targetsDetailed } from './actions.js';
import { buildContext, type ContextSources } from './chatContext.js';
import { opencode } from './chatOpencode.js';
import { onSessionEnd, requirePerm, userOf } from './session.js';

/**
 * Agent chat, /api/chat/*. Everything here needs the `chat` permission (admin
 * and up): the agent runs shell commands as bahar, who has sudo, so this is
 * as strong as the terminal.
 *
 * The agent keeps the sessions; Pulse only relays. One upstream event stream
 * (the adapter's) is fanned out to the browser streams on
 * GET /api/chat/events?session=<id>: session-list events to every stream,
 * the rest only to the streams watching that session.
 */

const adapter: ChatAdapter = opencode;

const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;
const REQUEST_ID = /^per_[A-Za-z0-9]{8,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{8,64}$/;
const PROMPT_MAX = 100_000;
const TITLE_MAX = 200;

interface Client {
  readonly res: Response;
  /** Pulse login (session hash). */
  readonly login: string;
  /** The agent session this tab shows, if any. */
  readonly watch: string | null;
}

const clients = new Set<Client>();
const MAX_PER_LOGIN = 6;
const MAX_TOTAL = 32;
const HEARTBEAT_MS = 25_000;
/** Same reason as stream.ts: a reader that stopped would queue without end. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function drop(c: Client): void {
  if (clients.delete(c)) c.res.end();
}

function write(c: Client, event: string, data: string): void {
  if (c.res.writableLength > MAX_QUEUED_BYTES) {
    clients.delete(c);
    c.res.destroy();
    return;
  }
  c.res.write(`event: ${event}\ndata: ${data}\n\n`);
}

/** The permission is checked on every event: one taken away ends the stream. */
function mayChat(login: string): boolean {
  return !!userOf(login)?.permissions.includes('chat');
}

function broadcast(e: ChatEvent): void {
  const target = chatEventSession(e);
  const data = JSON.stringify(e);
  for (const c of [...clients]) {
    if (target !== null && c.watch !== target) continue;
    if (!mayChat(c.login)) {
      write(c, 'bye', '{}');
      drop(c);
      continue;
    }
    write(c, 'chat', data);
  }
}

const heartbeat = setInterval(() => {
  for (const c of [...clients]) write(c, 'ping', '{}');
}, HEARTBEAT_MS);
heartbeat.unref();

onSessionEnd((hash) => {
  for (const c of [...clients]) {
    if (c.login !== hash) continue;
    write(c, 'bye', '{}');
    drop(c);
  }
});

function openEvents(req: Request, res: Response): void {
  const login = res.locals.sessionHash as string;
  const raw = typeof req.query.session === 'string' ? req.query.session : '';
  if (raw && !SESSION_ID.test(raw)) {
    res.status(400).json({ error: 'bad session id' });
    return;
  }
  let mine = 0;
  for (const c of clients) if (c.login === login) mine += 1;
  if (mine >= MAX_PER_LOGIN || clients.size >= MAX_TOTAL) {
    res.status(429).json({ error: 'too many open chat streams' });
    return;
  }
  adapter.start(broadcast);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client: Client = { res, login, watch: raw || null };
  clients.add(client);
  const status = adapter.status();
  if (status) write(client, 'chat', JSON.stringify({ type: 'upstream', status } satisfies ChatEvent));
  const gone = () => clients.delete(client);
  req.on('close', gone);
  res.on('error', gone);
}

/** Ends every chat stream and the upstream one, for shutdown. */
export function closeChat(): void {
  for (const c of clients) c.res.end();
  clients.clear();
  adapter.stop();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Runs a handler; a ChatError becomes its status, anything else a 500. */
const wrap =
  (fn: Handler): RequestHandler =>
  (req, res) => {
    // Through a promise, so a synchronous throw (a bad id) lands here too.
    Promise.resolve()
      .then(() => fn(req, res))
      .then(
      (body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      },
      (err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof ChatError) {
          res.status(err.status).json({ error: err.message, upstream: adapter.status() });
          return;
        }
        console.error('[chat]', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'chat request failed' });
      },
    );
  };

function sessionParam(req: Request): string {
  const id = String(req.params.id ?? '');
  if (!SESSION_ID.test(id)) throw new ChatError(400, 'bad session id');
  return id;
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function title(v: unknown): string {
  if (typeof v !== 'string') throw new ChatError(400, 'title required');
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > TITLE_MAX) throw new ChatError(400, `title must be 1 to ${TITLE_MAX} characters`);
  return t;
}

function model(v: unknown): ChatModelRef | null {
  if (v === undefined || v === null) return null;
  const m = v as { providerID?: unknown; modelID?: unknown };
  const ok = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\s\0]/.test(s);
  if (!ok(m.providerID) || !ok(m.modelID)) throw new ChatError(400, 'bad model');
  return { providerID: m.providerID, modelID: m.modelID };
}

const COMMAND_NAME = /^[\w.:@/-]{1,120}$/;
const MAX_MENTIONS = 40;

/** @mentions sent with a prompt: files (relative paths) and agent names. */
function mentions(v: unknown): ChatMention[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_MENTIONS) throw new ChatError(400, 'bad mentions');
  return v.map((m: { type?: unknown; value?: unknown }) => {
    const ok = (m.type === 'file' || m.type === 'agent') && typeof m.value === 'string' && m.value.length > 0 && m.value.length <= 500 && !/[\0\n]/.test(m.value);
    if (!ok) throw new ChatError(400, 'bad mention');
    return { type: m.type as 'file' | 'agent', value: m.value as string };
  });
}

const ATTACH_MAX = 4;
/** Base64 characters: one file, and all of them. The body cap (512 KB, index.ts) also holds the text. */
const ATTACH_ITEM_CHARS = 400_000;
const ATTACH_TOTAL_CHARS = 420_000;
const ATTACH_IMAGES: Readonly<Record<string, (b: Buffer) => boolean>> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG',
  'image/gif': (b) => b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
/** A person picks these from their own device, but keys and env files do not belong in a chat. */
const SECRET_NAME = /^(?:\.env(?:\..*)?|web\.env|terminal\.secret|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;

/** Files sent with a prompt, checked: allowed type, real content for that type, sizes, no secret-looking names. */
function attachments(v: unknown): ChatAttachment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACH_MAX) throw new ChatError(400, `at most ${ATTACH_MAX} attachments`);
  let total = 0;
  return v.map((a: { name?: unknown; mime?: unknown; data?: unknown }) => {
    if (typeof a?.name !== 'string' || typeof a.mime !== 'string' || typeof a.data !== 'string') throw new ChatError(400, 'bad attachment');
    const name = a.name.replace(/[\0-\x1f\x7f]/g, '').split(/[\\/]/).pop()!.trim().slice(0, 120) || 'file';
    if (SECRET_NAME.test(name)) throw new ChatError(400, `${name} looks like a secret file: paste only the part the agent needs`);
    if (a.data.length === 0 || a.data.length > ATTACH_ITEM_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(a.data)) throw new ChatError(400, `${name}: bad or too large data`);
    total += a.data.length;
    if (total > ATTACH_TOTAL_CHARS) throw new ChatError(413, 'attachments are too large together');
    const bytes = Buffer.from(a.data, 'base64');
    const sniff = Object.hasOwn(ATTACH_IMAGES, a.mime) ? ATTACH_IMAGES[a.mime] : undefined;
    if (sniff) {
      if (!sniff(bytes)) throw new ChatError(400, `${name} is not a ${a.mime} image`);
    } else if (a.mime === 'text/plain') {
      if (bytes.includes(0)) throw new ChatError(400, `${name} is not a text file`);
    } else {
      throw new ChatError(400, `${name}: only images and text files`);
    }
    return { name, mime: a.mime, data: a.data };
  });
}

/** Prompt (and command) bodies may be longer than the app-wide 16 KB JSON cap (see index.ts). */
export const CHAT_PROMPT_PATH = /^\/api\/chat\/sessions\/[^/]+\/(prompt|command)$/;

export function registerChatRoutes(app: Express, readLimiter: RequestHandler, writeLimiter: RequestHandler, sources: ContextSources): void {
  // Every /api/chat route, known or not, answers 403 without the permission.
  app.use('/api/chat', requirePerm('chat'));

  // Follow the agent from boot, not from the first open tab: auto mode answers
  // permission requests even while nobody has the chat open.
  adapter.start(broadcast);

  app.get('/api/chat/status', readLimiter, wrap(async () => ({ agent: adapter.agent, status: await adapter.probe(), directory: adapter.directory })));

  app.get('/api/chat/events', openEvents);

  app.get('/api/chat/providers', readLimiter, wrap(() => adapter.providers()));

  app.get('/api/chat/commands', readLimiter, wrap(async () => ({ commands: await adapter.commands() })));

  app.get('/api/chat/agents', readLimiter, wrap(async () => ({ agents: await adapter.subagents() })));

  // @ completion: paths in the session's directory (the default one before the first message).
  app.get(
    '/api/chat/files',
    readLimiter,
    wrap(async (req) => {
      const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : null;
      if (session && !SESSION_ID.test(session)) throw new ChatError(400, 'bad session id');
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      if (q.length > 300 || /[\0\n]/.test(q)) throw new ChatError(400, 'bad query');
      return { files: await adapter.findFiles(session, q) };
    }),
  );

  // Host facts for the message box (metrics, logs, alerts...): the person reads and edits them before sending.
  app.get(
    '/api/chat/context',
    readLimiter,
    wrap(async (req) => {
      const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max && !/[\0\n]/.test(v) ? v : undefined);
      const lines = Number.parseInt(String(req.query.lines ?? ''), 10);
      return buildContext(
        {
          kind: str(req.query.kind, 20) ?? '',
          name: str(req.query.name, 128),
          lines: Number.isFinite(lines) ? lines : undefined,
          priority: str(req.query.priority, 12) ?? null,
        },
        sources,
      );
    }),
  );

  // What Service control can act on: lets the chat offer a Run button for `systemctl restart x` in an answer.
  app.get('/api/chat/targets', readLimiter, wrap(async () => targetsDetailed()));

  app.get('/api/chat/sessions', readLimiter, wrap(async () => ({ sessions: await adapter.listSessions() })));

  app.post(
    '/api/chat/sessions',
    writeLimiter,
    wrap(async (req) => {
      const b = body(req);
      return { session: await adapter.createSession(b.title === undefined ? null : title(b.title)) };
    }),
  );

  app.get('/api/chat/sessions/:id', readLimiter, wrap((req) => adapter.history(sessionParam(req))));

  app.patch('/api/chat/sessions/:id', writeLimiter, wrap(async (req) => ({ session: await adapter.rename(sessionParam(req), title(body(req).title)) })));

  app.delete(
    '/api/chat/sessions/:id',
    writeLimiter,
    wrap(async (req) => {
      await adapter.remove(sessionParam(req));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/prompt',
    writeLimiter,
    wrap(async (req) => {
      const id = sessionParam(req);
      const b = body(req);
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text) throw new ChatError(400, 'message required');
      if (text.length > PROMPT_MAX) throw new ChatError(413, `message longer than ${PROMPT_MAX} characters`);
      await adapter.prompt(id, text, model(b.model), mentions(b.mentions), attachments(b.attachments));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/command',
    writeLimiter,
    wrap(async (req) => {
      const id = sessionParam(req);
      const b = body(req);
      const name = typeof b.command === 'string' ? b.command : '';
      if (!COMMAND_NAME.test(name)) throw new ChatError(400, 'bad command');
      const args = typeof b.arguments === 'string' ? b.arguments.trim() : '';
      if (args.length > PROMPT_MAX) throw new ChatError(413, `arguments longer than ${PROMPT_MAX} characters`);
      await adapter.command(id, name, args, model(b.model));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/compact',
    writeLimiter,
    wrap(async (req) => {
      await adapter.compact(sessionParam(req), model(body(req).model));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/undo',
    writeLimiter,
    wrap((req) => {
      const id = sessionParam(req);
      const m = body(req).messageID;
      if (m !== undefined && m !== null && (typeof m !== 'string' || !MESSAGE_ID.test(m))) throw new ChatError(400, 'bad message id');
      return adapter.undo(id, typeof m === 'string' ? m : null);
    }),
  );

  app.post(
    '/api/chat/sessions/:id/redo',
    writeLimiter,
    wrap(async (req) => {
      await adapter.redo(sessionParam(req));
    }),
  );

  app.post('/api/chat/sessions/:id/share', writeLimiter, wrap((req) => adapter.share(sessionParam(req))));

  app.post(
    '/api/chat/sessions/:id/auto',
    writeLimiter,
    wrap(async (req) => {
      const on = body(req).on;
      if (typeof on !== 'boolean') throw new ChatError(400, 'on must be true or false');
      return { session: await adapter.setAuto(sessionParam(req), on) };
    }),
  );

  app.delete(
    '/api/chat/sessions/:id/share',
    writeLimiter,
    wrap(async (req) => {
      await adapter.unshare(sessionParam(req));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/abort',
    writeLimiter,
    wrap(async (req) => {
      await adapter.abort(sessionParam(req));
    }),
  );

  app.post(
    '/api/chat/sessions/:id/permissions/:requestID',
    writeLimiter,
    wrap(async (req) => {
      const id = sessionParam(req);
      const requestID = String(req.params.requestID ?? '');
      if (!REQUEST_ID.test(requestID)) throw new ChatError(400, 'bad request id');
      const reply = body(req).reply;
      if (reply !== 'once' && reply !== 'always' && reply !== 'reject') throw new ChatError(400, 'reply must be once, always or reject');
      await adapter.reply(id, requestID, reply);
    }),
  );
}
