import type { Request, Response } from 'express';
import { onSessionEnd } from './session.js';

/**
 * Server-sent events: the server pushes instead of every tab polling.
 *
 * One GET /api/stream per tab. Events:
 *   stats    the telemetry payload, every sampler tick (5 s)
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
/** Latest JSON per event, replayed to a new connection. */
const latest = new Map<string, string>();

const MAX_PER_SESSION = 8;
const MAX_TOTAL = 64;
/** Proxies (cloudflared) drop a connection that is silent for long. */
const HEARTBEAT_MS = 25_000;

function write(res: Response, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

const heartbeat = setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, HEARTBEAT_MS);
heartbeat.unref();

onSessionEnd((hash) => {
  for (const c of [...clients]) {
    if (c.session !== hash) continue;
    write(c.res, 'bye', '{}');
    c.res.end();
    clients.delete(c);
  }
});

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
  for (const [event, data] of latest) write(res, event, data);

  const client: Client = { res, session };
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
  for (const c of clients) write(c.res, event, data);
}

export function streamCount(): number {
  return clients.size;
}
