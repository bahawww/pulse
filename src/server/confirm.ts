import { randomBytes } from 'node:crypto';

/**
 * Two-phase confirmation tokens, shared by service actions (actions.ts) and the
 * performance panel (performance.ts). A mutation first returns a token bound to
 * a key describing exactly what will run; the second request must echo it
 * within CONFIRM_TTL_MS. Each token works once.
 */

const CONFIRM_TTL_MS = 30_000;
/** A client that never confirms should not accumulate tokens. */
const MAX_PENDING = 60;

const pending = new Map<string, { readonly key: string; readonly expiresAt: number }>();

export function issueToken(key: string): string {
  const token = randomBytes(16).toString('hex');
  pending.set(token, { key, expiresAt: Date.now() + CONFIRM_TTL_MS });
  // Insertion order is expiry order (fixed TTL), so the first key is the oldest.
  if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  return token;
}

/** True when `token` was issued for `key` and has not expired. Spends the token either way. */
export function consumeToken(token: string | null, key: string): boolean {
  if (!token) return false;
  const entry = pending.get(token);
  pending.delete(token);
  return !!entry && entry.expiresAt >= Date.now() && entry.key === key;
}
