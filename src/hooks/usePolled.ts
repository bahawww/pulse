import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Generic polling hook for the slow-moving panels.
 *
 * Alerts, spend and reachability do not change at the 5-second telemetry rate,
 * and two of them cost something to compute — spend reads a SQLite file,
 * reachability can make an outbound request. Polling them on the telemetry
 * cadence would be wasteful at best and self-inflicted load at worst, so each
 * declares its own interval.
 *
 * `enabled` exists so a collapsed or unselected panel stops fetching entirely
 * rather than continuing to poll a view nobody is looking at.
 */

export interface PolledState<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly loading: boolean;
  /** True once at least one successful load has happened. */
  readonly ready: boolean;
  readonly refresh: () => void;
}

export function usePolled<T>(
  path: string,
  intervalMs: number,
  enabled = true,
): PolledState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  // Bumping this forces a refetch without remounting the effect.
  const [nonce, setNonce] = useState(0);

  // Guards against a slow response from a previous path overwriting a newer one
  // when the panel switches between ranges or targets.
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const id = requestId.current + 1;
    requestId.current = id;

    const load = async () => {
      try {
        const res = await fetch(path, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as T;
        if (requestId.current !== id) return; // a newer request superseded this
        setData(body);
        setError(null);
        setReady(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestId.current !== id) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, intervalMs, enabled, nonce]);

  return { data, error, loading, ready, refresh };
}