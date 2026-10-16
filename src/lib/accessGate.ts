/**
 * Cloudflare Access in front of the public hostname: when its sign-in for this
 * browser runs out, every API call is redirected to the Access login page on
 * another domain. fetch() cannot follow that (CORS), so it only says "Failed to
 * fetch", which looks like the server being down. A request with
 * redirect: 'manual' tells the two apart: an opaque redirect means a gate in
 * front of us wants a fresh sign-in, and only a full page load can do it.
 */
export async function behindExpiredGate(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', redirect: 'manual', credentials: 'same-origin' });
    return res.type === 'opaqueredirect';
  } catch {
    return false;
  }
}
