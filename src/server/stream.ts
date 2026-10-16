import type { Request, Response } from 'express';
import { onSessionEnd, userOf } from './session.js';
import type { Permission } from '../shared/contract.js';

/**
 * Server-sent events: the server pushes instead of every tab polling.
 *
 * One GET /api/stream per tab. Events:
 *   stats    the telemetry payload, every sampler tick (5 s), cut to what the
 *            reader's permissions may see (scope.ts)
 *   alerts   the alert snapshot, when it changes
 *   actions  the action audit log, after an action runs
 *   bye      the session ended (logout or expiry); the client re-checks login
 *
 * A new connection gets the latest value of each event at once, so a page
 * paints without waiting for the next tick. EventSource reconnects by itself
 * (`retry:`), and the client falls back to polling while the stream is down.
 */

interface Client {
  readonly res: Response;
  readonly session: string;
}

const clients = new Set<Client>();
/** A payload that depends on who reads it (see publishScoped). */
type Scoped = (permissions: readonly Permission[]) => unknown;
/** Latest value per event, replayed to a new connection: JSON, or a scoped payload. */
const latest = new Map<string, string | Scoped>();

const MAX_PER_SESSION = 8;
const MAX_TOTAL = 64;
/** Proxies (cloudflared) drop a connection that is silent for long. */
const HEARTBEAT_MS = 25_000;
/**
 * A stream whose reader stopped (a phone asleep with the socket still open)
 * queues every event in memory until TCP gives up, which takes many minutes.
 * Past this much unsent data it is closed; EventSource reconnects on its own.
 */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function write(c: Client, event: string, data: string): void {
  if (c.res.writableLength > MAX_QUEUED_BYTES) {
    clients.delete(c);
    c.res.destroy();
    return;
  }
  c.res.write(`event: ${event}\ndata: ${data}\n\n`);
}

const heartbeat = setInterval(() => {
  // A named event, not a comment: the client's watchdog can only see events.
  for (const c of [...clients]) write(c, 'ping', '{}');
}, HEARTBEAT_MS);
heartbeat.unref();

onSessionEnd((hash) => {
  for (const c of [...clients]) {
    if (c.session !== hash) continue;
    write(c, 'bye', '{}');
    // write() drops (and has already destroyed) a stream that stopped reading.
    if (clients.delete(c)) c.res.end();
  }
});

/** Events only some users may receive; the rest go to every stream. */
const EVENT_PERM: Readonly<Record<string, Permission>> = { actions: 'view:logs' };

function allowed(session: string, event: string): boolean {
  const need = EVENT_PERM[event];
  return !need || !!userOf(session)?.permissions.includes(need);
}

export function openStream(req: Request, res: Response, session: string): void {
  let mine = 0;
  for (const c of clients) if (c.session === session) mine += 1;
  if (mine >= MAX_PER_SESSION || clients.size >= MAX_TOTAL) {
    res.status(429).json({ error: 'too many open streams' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    // Tells nginx-style proxies not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client: Client = { res, session };
  for (const [event, data] of latest) {
    if (!allowed(session, event)) continue;
    write(client, event, typeof data === 'string' ? data : JSON.stringify(data(userOf(session)?.permissions ?? [])));
  }

  clients.add(client);
  const gone = () => clients.delete(client);
  req.on('close', gone);
  res.on('error', gone);
}

/**
 * Sends an event to every open stream. With `dedupe`, a value equal to the last
 * one sent is skipped (alerts change rarely; their snapshot is built every tick).
 */
export function publish(event: string, payload: unknown, dedupe = false): void {
  const data = JSON.stringify(payload);
  if (dedupe && latest.get(event) === data) return;
  latest.set(event, data);
  for (const c of [...clients]) if (allowed(c.session, event)) write(c, event, data);
}

/**
 * Sends an event whose payload depends on the reader's permissions (the stats,
 * cut by src/server/scope.ts). Built and serialised once per set of permissions,
 * not once per stream.
 */
export function publishScoped(event: string, payloadFor: Scoped): void {
  latest.set(event, payloadFor);
  const built = new Map<string, string>();
  for (const c of [...clients]) {
    if (!allowed(c.session, event)) continue;
    const permissions = userOf(c.session)?.permissions ?? [];
    const key = permissions.join();
    let data = built.get(key);
    if (data === undefined) {
      data = JSON.stringify(payloadFor(permissions));
      built.set(key, data);
    }
    write(c, event, data);
  }
}

export function streamCount(): number {
  return clients.size;
}

/**
 * Ends every stream, for shutdown. No `bye`: that means "logged out". A plain
 * end makes EventSource reconnect by itself once the server is back.
 */
export function closeStreams(): void {
  for (const c of clients) c.res.end();
  clients.clear();
}
