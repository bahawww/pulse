import { useEffect, useState } from 'react';

/**
 * One EventSource per tab on /api/stream (src/server/stream.ts), shared by
 * every hook that wants live data. It opens with the first subscriber and
 * closes a few seconds after the last one leaves.
 *
 * `live` is true while the stream is connected. Hooks poll only while it is
 * false, so a proxy that breaks event streams still leaves a working page.
 */

type Listener = (data: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const liveListeners = new Set<(live: boolean) => void>();
let source: EventSource | null = null;
let live = false;
let refs = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** Client clock at the last message of any kind, including the server's ping. */
let lastMessageAt = 0;
/** The server pings every 25 s; this much silence means the stream is dead without telling us. */
const SILENT_MS = 70_000;

/** Fired on window when the server says the session ended, or the stream is refused. */
export const SESSION_CHECK_EVENT = 'pulse:session-check';

function setLive(next: boolean): void {
  if (live === next) return;
  live = next;
  for (const fn of liveListeners) fn(next);
}

function attach(es: EventSource, event: string): void {
  es.addEventListener(event, (e) => {
    lastMessageAt = Date.now();
    let data: unknown;
    try {
      data = JSON.parse((e as MessageEvent<string>).data);
    } catch {
      return;
    }
    for (const fn of listeners.get(event) ?? []) fn(data);
  });
}

function open(): void {
  if (source || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/stream');
  source = es;
  lastMessageAt = Date.now();
  attach(es, 'ping');
  for (const event of listeners.keys()) attach(es, event);
  es.addEventListener('bye', () => {
    close();
    window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
  });
  es.onopen = () => {
    failures = 0;
    setLive(true);
  };
  es.onerror = () => {
    setLive(false);
    // CONNECTING: the browser retries on its own. CLOSED: refused (401, 429), so
    // check the login and try again later, backing off.
    if (es.readyState !== EventSource.CLOSED) return;
    source = null;
    failures += 1;
    window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
    clearTimeout(retryTimer);
    if (refs > 0) retryTimer = setTimeout(open, Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
  };
}

/** Drops the current EventSource and opens a fresh one, without flipping `live` off for long. */
function reconnect(): void {
  if (refs === 0) return;
  source?.close();
  source = null;
  open();
}

if (typeof document !== 'undefined') {
  // A tab left idle can have its socket killed by a NAT or proxy with no error
  // event. Check on return and on a timer, and reconnect if it went quiet.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && source && Date.now() - lastMessageAt > 30_000) reconnect();
  });
  setInterval(() => {
    if (source && document.visibilityState === 'visible' && Date.now() - lastMessageAt > SILENT_MS) reconnect();
  }, 10_000);
}

function close(): void {
  clearTimeout(retryTimer);
  source?.close();
  source = null;
  setLive(false);
}

/** Calls `fn` with each `event` payload. Returns the unsubscribe function. */
export function subscribe(event: string, fn: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
    if (source) attach(source, event);
  }
  set.add(fn);
  refs += 1;
  clearTimeout(closeTimer);
  open();
  return () => {
    set.delete(fn);
    refs -= 1;
    if (refs === 0) closeTimer = setTimeout(close, 5000);
  };
}

export function streamLive(): boolean {
  return live;
}

/** True while the stream is connected; re-renders on change. */
export function useStreamLive(): boolean {
  const [v, setV] = useState(live);
  useEffect(() => {
    setV(live);
    liveListeners.add(setV);
    return () => {
      liveListeners.delete(setV);
    };
  }, []);
  return v;
}
