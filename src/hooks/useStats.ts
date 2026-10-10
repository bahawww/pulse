import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatsPayload } from '../shared/contract';
import { subscribe, useStreamLive } from '../lib/stream';

const POLL_INTERVAL_MS = 5000;
/** A poll that takes longer than this is abandoned and retried. */
const TIMEOUT_MS = 10_000;

/**
 * Live telemetry. The server pushes each sample over /api/stream (SSE); this
 * hook only polls /api/stats while that stream is down, with a visibility
 * guard and backoff so a downed backend doesn't produce a tight retry loop.
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
  const live = useStreamLive();

  useEffect(
    () =>
      subscribe('stats', (payload) => {
        setData(payload as StatsPayload);
        setError(null);
        setLastOkAt(Date.now());
        failureCount.current = 0;
      }),
    [],
  );

  const fetchOnce = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Server took more than ${TIMEOUT_MS / 1000}s to answer`)),
      TIMEOUT_MS,
    );
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
      // An abort carries the timeout message as its reason; a network drop is
      // "Failed to fetch". Either way the banner gets a sentence a person can read.
      const reason = controller.signal.aborted ? controller.signal.reason : err;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    aborted.current = false;
    // Pushed: nothing to poll. A manual refresh still fetches once.
    if (live) {
      if (manualRefresh > 0) void fetchOnce();
      return () => {
        aborted.current = true;
      };
    }

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
  }, [fetchOnce, manualRefresh, live]);

  const refresh = useCallback(() => setManualRefresh((n) => n + 1), []);

  return { data, error, refresh, lastOkAt };
}