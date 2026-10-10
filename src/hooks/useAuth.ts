import { useCallback, useEffect, useState } from 'react';
import { postJson, setCsrf } from '../lib/csrf';
import { SESSION_CHECK_EVENT, useStreamLive } from '../lib/stream';

export interface AuthUser {
  readonly name: string;
  readonly role: 'admin';
}

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'anon' }
  | { readonly status: 'authed'; readonly user: AuthUser };

export interface AuthHandle {
  readonly state: AuthState;
  /** Resolves to an error message, or null on success. */
  readonly login: (username: string, password: string) => Promise<string | null>;
  readonly logout: () => Promise<void>;
}

const RECHECK_MS = 60_000;

/**
 * Who is logged in, from the server's session cookie. The live stream tells
 * the page when the session ends; the timed recheck runs only while it is down.
 */
export function useAuth(): AuthHandle {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { user: AuthUser; csrf?: string };
        setCsrf(body.csrf);
        setState({ status: 'authed', user: body.user });
      } else {
        setCsrf(null);
        setState({ status: 'anon' });
      }
    } catch {
      // Network blip: keep whatever we had instead of dropping to the login page.
    }
  }, []);

  const live = useStreamLive();

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    window.addEventListener(SESSION_CHECK_EVENT, onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(SESSION_CHECK_EVENT, onFocus);
    };
  }, [check]);

  useEffect(() => {
    if (live) return;
    const id = setInterval(() => void check(), RECHECK_MS);
    return () => clearInterval(id);
  }, [check, live]);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { user?: AuthUser; error?: string; csrf?: string };
      if (res.ok && body.user) {
        setCsrf(body.csrf);
        setState({ status: 'authed', user: body.user });
        return null;
      }
      return body.error ?? `login failed (${res.status})`;
    } catch {
      return 'server unreachable';
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await postJson('/api/auth/logout');
    } finally {
      setCsrf(null);
      setState({ status: 'anon' });
    }
  }, []);

  return { state, login, logout };
}
