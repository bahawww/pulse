/**
 * The session's CSRF token (see src/server/csrf.ts). The server hands it out
 * with /api/auth/me and the login answer; every state-changing call sends it
 * back in X-CSRF-Token, and the terminal sends it as a WebSocket subprotocol.
 * Kept in memory only: never in storage, never in a URL.
 */

let token: string | null = null;
let inflight: Promise<string | null> | null = null;

export function setCsrf(next: string | null | undefined): void {
  token = typeof next === 'string' && next ? next : null;
}

/** The token, fetched once from /api/auth/me when the page does not have it yet. */
export function ensureCsrf(): Promise<string | null> {
  if (token) return Promise.resolve(token);
  inflight ??= fetch('/api/auth/me', { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (res.ok) setCsrf(((await res.json()) as { csrf?: string }).csrf);
      return token;
    })
    .catch(() => token)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * POST JSON with the CSRF token. A 403 for a stale token (server restarted
 * with a new key, a new login in another tab) refreshes it and retries once.
 */
export async function postJson(path: string, body: unknown = {}): Promise<Response> {
  const send = async () =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': (await ensureCsrf()) ?? '' },
      body: JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 403) {
    const reason = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (reason.code === 'csrf') {
      token = null;
      res = await send();
    }
  }
  return res;
}
