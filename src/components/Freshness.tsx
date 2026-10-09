import { type JSX } from 'react';
import { useNow } from '../hooks/useNow';
import { formatAgo, formatClock, zoneLabel } from '../lib/format';

/** How old the last good reading may get before the UI calls it stale. Several missed 5s polls. */
export const STALE_MS = 20_000;

/**
 * True when there is data on screen but it no longer reflects the server. Age
 * decides, not a single failed poll: one slow answer (a busy network, a long
 * history download alongside it) must not flash "connection lost" over data
 * that is still seconds old. `error` only matters once the data is old too.
 */
export function isStale(hasData: boolean, _error: Error | null, lastOkAt: number | null, now: number): boolean {
  if (!hasData || lastOkAt === null) return false;
  return now - lastOkAt > STALE_MS;
}

function ago(lastOkAt: number, now: number): string {
  const ms = Math.max(0, now - lastOkAt);
  return ms < 3000 ? 'just now' : formatAgo(ms);
}

/**
 * "Updated 4s ago", ticking every second. Lives in its own component so the
 * one-second tick re-renders this label, not the dashboard around it.
 */
export function Freshness({ lastOkAt, stale }: { readonly lastOkAt: number | null; readonly stale: boolean }): JSX.Element {
  const now = useNow(1000);
  if (lastOkAt === null) return <span className="fresh">Waiting for first sync</span>;
  return (
    <span className={`fresh${stale ? ' is-stale' : ''}`} title={`Last reading ${formatClock(lastOkAt)} ${zoneLabel()}`.trim()}>
      <span className="fresh-dot" aria-hidden="true" />
      {stale ? 'Last update' : 'Updated'} {ago(lastOkAt, now)}
      <span className="fresh-clock">
        · {formatClock(lastOkAt)} {zoneLabel()}
      </span>
    </span>
  );
}

/**
 * Shown on every view while the data is stale: the numbers below are frozen at
 * the last good reading, and this says so instead of letting them pass as live.
 */
export function StaleBanner({
  lastOkAt,
  error,
  onRetry,
}: {
  readonly lastOkAt: number | null;
  readonly error: Error | null;
  readonly onRetry: () => void;
}): JSX.Element {
  const now = useNow(1000);
  return (
    <div className="stale-banner" role="alert">
      <span className="lamp lamp-sm is-crit" aria-hidden="true" />
      <div className="stale-copy">
        <strong>Connection to the server lost.</strong>{' '}
        <span>
          {lastOkAt !== null
            ? `Showing data from ${formatClock(lastOkAt)} (${ago(lastOkAt, now)}). `
            : 'Showing the last data received. '}
          Retrying automatically{error?.message ? ` · ${error.message}` : ''}.
        </span>
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}
