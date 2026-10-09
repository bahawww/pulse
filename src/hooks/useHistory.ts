import { useCallback, useEffect, useRef, useState } from 'react';
import { TIME_RANGES, type HistoryPayload, type TimeRangeId } from '../shared/contract';

/**
 * Polls /api/history for the trend charts, scoped to a chosen time range.
 *
 * The range is a server-side concern, not a client-side filter. Asking for "6h"
 * means the server returns 1-minute averages instead of 8,640 raw 5s points, so
 * changing the range changes the request rather than re-slicing what is already
 * in memory. That is also why the fetch depends on `range`: the previous version
 * fetched once and the chart was stuck at whatever window the first load
 * happened to ask for.
 *
 * Poll cadence is scaled to the range. A 12-hour view does not need refreshing
 * every 5 seconds — the underlying bucket does not change that fast, and
 * re-pulling a few hundred KB five times a minute for a chart whose leftmost
 * point is from this morning is waste.
 */

interface HistoryResponse extends HistoryPayload {
  readonly storage?: {
    readonly rawCount: number;
    readonly archiveCount: number;
    readonly maxSpanMs: number;
    /** True when telemetry is being written to SQLite. */
    readonly persisted?: boolean;
    /** Rows currently in the durable store. */
    readonly storedRows?: number;
    /** Why persistence is off, when it is. */
    readonly error?: string | null;
  };
}

/** 5s for short windows, slower once the data is minute-averaged. */
function cadenceFor(range: TimeRangeId): number {
  switch (range) {
    case '5m':
    case '15m':
      return 5000;
    case '1h':
      return 10_000;
    default:
      return 30_000;
  }
}

export function useHistory(intervalMs?: number) {
  const [range, setRange] = useState<TimeRangeId>('15m');
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // The range whose data is on screen. Differs from `range` while a newly
  // chosen range is loading; the old chart stays up until the new one lands.
  const [shownRange, setShownRange] = useState<TimeRangeId | null>(null);
  // One request in flight at a time: a newer one (another range, or the next
  // poll) cancels the older, so a slow 24h answer can never land on top of a
  // newer 1h one, and switching quickly does not queue up downloads.
  const inflight = useRef<AbortController | null>(null);

  const rangeDef = TIME_RANGES.find((r) => r.id === range) ?? TIME_RANGES[1];
  const cadence = intervalMs ?? cadenceFor(range);

  const fetchHistory = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const res = await fetch(`/api/history?ms=${rangeDef.ms}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as HistoryResponse;
      if (controller.signal.aborted) return;
      setHistory(payload);
      setShownRange(rangeDef.id);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setLoading(false);
      }
    }
  }, [rangeDef.ms, rangeDef.id]);

  useEffect(() => {
    void fetchHistory();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchHistory();
    }, cadence);

    return () => {
      inflight.current?.abort();
      inflight.current = null;
      clearInterval(timer);
    };
  }, [fetchHistory, cadence]);

  return {
    history,
    error,
    loading,
    range,
    setRange,
    /** The range being fetched while its data is not on screen yet, else null. */
    pendingRange: shownRange !== null && shownRange !== range ? range : null,
    /** What the server can actually serve, which may be shorter than the range. */
    maxSpanMs: history?.maxSpanMs ?? 0,
  };
}
