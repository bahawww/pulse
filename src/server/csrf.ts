import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CSRF tokens.
 *
 * The session cookie is SameSite=Strict, which already keeps it off cross-site
 * requests in current browsers. The token is the second, independent layer: a
 * state-changing request must also carry a value that only a page on this
 * origin could have read.
 *
 * The token is HMAC(key, session hash). Nothing is stored per session, it
 * cannot be derived from the cookie without the key, it changes with every
 * login, and it dies with the session. The key lives in data/csrf.key (0600)
 * so a restart does not invalidate open pages.
 *
 * Carried as the `X-CSRF-Token` header on fetches, and as a WebSocket
 * subprotocol (`pulse.csrf.<token>`) on the terminal upgrade, where a browser
 * cannot set headers.
 */

export const CSRF_HEADER = 'x-csrf-token';
export const WS_PROTOCOL = 'pulse.v1';
const WS_TOKEN_PREFIX = 'pulse.csrf.';

const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const KEY_FILE = path.join(DATA_DIR, 'csrf.key');

function loadKey(): Buffer {
  try {
    const key = fs.readFileSync(KEY_FILE);
    if (key.length >= 32) return key;
  } catch {
    /* first run */
  }
  const key = randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (err) {
    // Still safe, only per-process: open pages need a reload after a restart.
    console.warn('[csrf] could not persist key:', err instanceof Error ? err.message : err);
  }
  return key;
}

const KEY = loadKey();

export function csrfToken(sessionHash: string): string {
  return createHmac('sha256', KEY).update(`csrf:${sessionHash}`).digest('base64url');
}

export function csrfValid(sessionHash: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false;
  const want = Buffer.from(csrfToken(sessionHash));
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The token from a `Sec-WebSocket-Protocol` header, if the client offered one. */
export function wsToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const p of raw.split(',')) {
    const v = p.trim();
    if (v.startsWith(WS_TOKEN_PREFIX)) return v.slice(WS_TOKEN_PREFIX.length);
  }
  return null;
}
