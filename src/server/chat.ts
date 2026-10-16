import type { Express, Request, RequestHandler, Response } from 'express';

import { chatEventSession, type ChatEvent, type ChatModelRef } from '../shared/contract.js';
import { ChatError, type ChatAdapter } from './chatAdapter.js';
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

/** Prompt bodies may be longer than the app-wide 16 KB JSON cap (see index.ts). */
export const CHAT_PROMPT_PATH = /^\/api\/chat\/sessions\/[^/]+\/prompt$/;

export function registerChatRoutes(app: Express, readLimiter: RequestHandler, writeLimiter: RequestHandler): void {
  // Every /api/chat route, known or not, answers 403 without the permission.
  app.use('/api/chat', requirePerm('chat'));

  app.get('/api/chat/status', readLimiter, wrap(async () => ({ agent: adapter.agent, status: await adapter.probe(), directory: adapter.directory })));

  app.get('/api/chat/events', openEvents);

  app.get('/api/chat/providers', readLimiter, wrap(() => adapter.providers()));

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
      await adapter.prompt(id, text, model(b.model));
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
