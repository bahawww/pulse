import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatsPayload } from '../shared/contract';

const POLL_INTERVAL_MS = 5000;

/**
 * Polls /api/stats with a visibility guard: a background tab would otherwise
 * keep 4 service probes alive every 5s forever. Also backs off on failure so a
 * downed backend doesn't produce a tight retry loop.
 */
export function useStats() {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Client clock at the last successful poll. The server's own timestamp is not
  // used for staleness: a skewed server clock would read as "stale" forever.
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const failureCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aborted = useRef(false);
  // Bumped on manual refresh so the polling effect re-runs immediately.
  const [manualRefresh, setManualRefresh] = useState(0);

  const fetchOnce = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/stats', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as StatsPayload;
      if (aborted.current) return;
      setData(payload);
      setError(null);
      setLastOkAt(Date.now());
      failureCount.current = 0;
    } catch (err) {
      if (aborted.current) return;
      failureCount.current += 1;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    aborted.current = false;

    const schedule = (delay: number) => {
      timer.current = setTimeout(async () => {
        if (aborted.current) return;
        await fetchOnce();
        // Exponential backoff capped at 30s: 5s, 10s, 20s, 30s, 30s...
        const backoff = failureCount.current === 0 ? POLL_INTERVAL_MS : Math.min(5000 * 2 ** failureCount.current, 30000);
        schedule(backoff);
      }, delay);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !aborted.current) {
        if (timer.current) clearTimeout(timer.current);
        void fetchOnce();
        schedule(POLL_INTERVAL_MS);
      }
    };

    void fetchOnce();
    schedule(POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      aborted.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchOnce, manualRefresh]);

  const refresh = useCallback(() => setManualRefresh((n) => n + 1), []);

  return { data, error, refresh, lastOkAt };
}