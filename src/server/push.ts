import fs from 'node:fs';
import path from 'node:path';
import webpush, { type PushSubscription } from 'web-push';

/**
 * Web Push: system notifications on a phone or laptop whose Pulse tab is in
 * the background or closed. Used by the terminal ("Notify when done", bells and
 * agent notices from a shell nobody is looking at).
 *
 * The VAPID key pair is made once and kept in the data dir (mode 600). Each
 * login name keeps up to MAX_PER_USER browser subscriptions. The server posts
 * only to the browser vendors' push services (PUSH_HOST), never to a URL a
 * client could point at this machine's own network.
 */

const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const KEYS_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const MAX_PER_USER = 10;

/** Chrome/Edge/Android (FCM), Firefox, Safari/iOS, Windows. */
const PUSH_HOST = /^(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*push\.apple\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)$/;

interface Keys {
  readonly publicKey: string;
  readonly privateKey: string;
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

function loadKeys(): Keys {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) as Keys;
    if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string') return k;
  } catch {
    /* first run */
  }
  const k = webpush.generateVAPIDKeys();
  writePrivate(KEYS_FILE, k);
  return k;
}

let keys: Keys | null = null;

function ready(): Keys {
  if (keys) return keys;
  keys = loadKeys();
  // Apple rejects a VAPID subject it cannot read as a real https or mailto contact.
  const base = process.env.VITE_BASE_DOMAIN;
  const subject = process.env.PUSH_SUBJECT || (base ? `https://${base}` : 'mailto:pulse@example.com');
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return keys;
}

export function publicKey(): string {
  return ready().publicKey;
}

type Subs = Record<string, PushSubscription[]>;

function loadSubs(): Subs {
  try {
    const s = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) as Subs;
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

let subs: Subs | null = null;
const allSubs = (): Subs => (subs ??= loadSubs());
const saveSubs = (): void => writePrivate(SUBS_FILE, allSubs());

/** A subscription from the browser, or an error to show. */
export function parseSubscription(body: unknown): PushSubscription | string {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!b || typeof b.endpoint !== 'string' || b.endpoint.length > 1024) return 'bad subscription';
  let url: URL;
  try {
    url = new URL(b.endpoint);
  } catch {
    return 'bad endpoint';
  }
  if (url.protocol !== 'https:' || !PUSH_HOST.test(url.hostname)) return 'unknown push service';
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,128}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,64}={0,2}$/.test(auth)) {
    return 'bad subscription keys';
  }
  return { endpoint: b.endpoint, keys: { p256dh, auth } };
}

export function subscribe(user: string, sub: PushSubscription): void {
  const list = (allSubs()[user] ?? []).filter((s) => s.endpoint !== sub.endpoint);
  list.push(sub);
  allSubs()[user] = list.slice(-MAX_PER_USER);
  saveSubs();
}

export function unsubscribe(user: string, endpoint: string): void {
  const list = allSubs()[user];
  if (!list) return;
  allSubs()[user] = list.filter((s) => s.endpoint !== endpoint);
  saveSubs();
}

export function hasSubscriptions(user: string): boolean {
  return (allSubs()[user]?.length ?? 0) > 0;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Same tag replaces the previous notification instead of stacking. */
  readonly tag: string;
  /** Opened when the notification is tapped (same origin path). */
  readonly url: string;
}

/** Sends to every device of `user`. Gone subscriptions (404/410) are dropped. */
export async function pushTo(user: string, msg: PushMessage): Promise<void> {
  const list = allSubs()[user];
  if (!list?.length) return;
  ready();
  const payload = JSON.stringify(msg);
  let changed = false;
  await Promise.all(
    list.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', timeout: 8000 });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          allSubs()[user] = (allSubs()[user] ?? []).filter((s) => s.endpoint !== sub.endpoint);
          changed = true;
        } else {
          console.warn(`[push] send failed (${code ?? (err instanceof Error ? err.message.slice(0, 80) : 'error')})`);
        }
      }
    }),
  );
  if (changed) saveSubs();
}
