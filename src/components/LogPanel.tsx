import { useCallback, useEffect, useState } from 'react';
import type { LogEntry } from '../shared/contract';
import { SelectMenu } from './SelectMenu';
import { BoneLines, Loading } from './Skeleton';

/**
 * Read-only journal tail.
 *
 * No auto-scroll: a panel that moves under your eyes is unreadable. Newest
 * entries sit at the top. Polls every 10 seconds, since journalctl forks a
 * process per call; this is a convenience view, not a live stream.
 */

interface LogResponse {
  readonly entries: readonly LogEntry[];
}

const LINES = [50, 120, 300] as const;
const SINCE = [
  { id: '15m', label: 'last 15 min', value: '-15m' },
  { id: '1h', label: 'last hour', value: '-1h' },
  { id: '24h', label: 'last 24 h', value: '-24h' },
  { id: 'all', label: 'all', value: '' },
] as const;

function levelClass(priority: string): string {
  const p = priority.toLowerCase();
  if (p === '0' || p === '1' || p === '2' || p === '3' || p === 'emerg' || p === 'alert' || p === 'crit' || p === 'err') {
    return 'is-err';
  }
  if (p === '4' || p === 'warning' || p === 'warn') return 'is-warn';
  return '';
}

export function LogPanel() {
  const [units, setUnits] = useState<string[]>([]);
  const [unit, setUnit] = useState('');
  const [lines, setLines] = useState<number>(120);
  const [since, setSince] = useState<string>('-1h');
  const [entries, setEntries] = useState<readonly LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Unit list is fetched once. Polling it would fork systemctl on every tick.
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/logs/units', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { units: string[] }) => {
        setUnits(body.units);
        // Default to this dashboard's own unit, the likeliest one to matter.
        setUnit((current) => current || 'vps-dashboard.service');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'could not list units');
      });
    return () => controller.abort();
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!unit) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ unit, lines: String(lines) });
        if (since) params.set('since', since);
        const res = await fetch(`/api/logs?${params.toString()}`, { cache: 'no-store', signal: signal ?? null });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as LogResponse;
        setEntries(body.entries);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setEntries(null);
        setError(err instanceof Error ? err.message : 'could not read logs');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [unit, lines, since],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  return (
    <section className="card" aria-labelledby="logs-h">
      <div className="card-head">
        <div>
          <h3 id="logs-h" className="card-title">
            Logs
          </h3>
          <p className="card-sub">journalctl, read only{loading ? ' · refreshing…' : ''}</p>
        </div>
      </div>

      <div className="toolbar-compact">
        <SelectMenu
          label="Unit"
          value={unit}
          options={units.length === 0 ? [{ value: unit, label: unit || 'loading units…' }] : units.map((u) => ({ value: u, label: u }))}
          onChange={setUnit}
        />
        <SelectMenu
          label="Lines"
          value={String(lines)}
          options={LINES.map((n) => ({ value: String(n), label: `${n} lines` }))}
          onChange={(v) => setLines(Number(v))}
        />
        <SelectMenu
          label="Since"
          value={since}
          options={SINCE.map((s) => ({ value: s.value, label: s.label }))}
          onChange={setSince}
        />
        <button type="button" className="btn btn-sm" onClick={() => void load()} style={{ marginLeft: 'auto' }}>
          Refresh
        </button>
      </div>

      {error && <p className="note is-error">{error}</p>}
      {!error && entries === null && (
        <Loading what="journal">
          <BoneLines count={8} />
        </Loading>
      )}
      {entries !== null && entries.length === 0 && <p className="empty">No entries for this unit in this window.</p>}

      {entries !== null && entries.length > 0 && (
        <ol className="log-list">
          {entries.map((entry, i) => (
            <li className={`log-row ${levelClass(entry.priority)}`} key={`${entry.ts}-${i}`}>
              <time className="log-time" dateTime={new Date(entry.ts).toISOString()}>
                {new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })}
              </time>
              <span className="log-message">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
