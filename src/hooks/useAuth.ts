import { useCallback, useEffect, useState } from 'react';

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

/** Who is logged in, from the server's session cookie. Rechecked so an expired login shows the login page. */
export function useAuth(): AuthHandle {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { user: AuthUser };
        setState({ status: 'authed', user: body.user });
      } else {
        setState({ status: 'anon' });
      }
    } catch {
      // Network blip: keep whatever we had instead of dropping to the login page.
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), RECHECK_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { user?: AuthUser; error?: string };
      if (res.ok && body.user) {
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
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setState({ status: 'anon' });
    }
  }, []);

  return { state, login, logout };
}
