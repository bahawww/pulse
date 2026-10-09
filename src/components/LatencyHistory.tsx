import { type JSX, useMemo } from 'react';
import type { HistorySample } from '../shared/contract';
import { formatMs } from '../lib/format';
import { TimeChart, type Series } from './TimeChart';

/**
 * Probe latency per service over time. A missing key is a failed probe, not a
 * zero, so an outage shows as a gap in the line.
 */

interface LatencyHistoryProps {
  readonly samples: readonly HistorySample[];
  readonly services: readonly { readonly id: string; readonly label: string }[];
}

const SLOTS = ['var(--s-cpu)', 'var(--s-mem)', 'var(--s-disk)', 'var(--s-rx)'] as const;

export function LatencyHistory({ samples, services }: LatencyHistoryProps): JSX.Element {
  const times = useMemo(() => samples.map((s) => s.t), [samples]);

  const series = useMemo<Series[]>(
    () =>
      services.map((svc, i) => ({
        key: svc.id,
        label: svc.label,
        color: SLOTS[i % SLOTS.length] ?? 'var(--accent)',
        values: samples.map((s) => s.latency?.[svc.id] ?? Number.NaN),
        times,
      })),
    [samples, services, times],
  );

  const latest = useMemo(
    () =>
      services.map((svc) => {
        for (let i = samples.length - 1; i >= 0; i--) {
          const v = samples[i]?.latency?.[svc.id];
          if (v !== undefined) return { id: svc.id, label: svc.label, value: v };
        }
        return { id: svc.id, label: svc.label, value: null as number | null };
      }),
    [samples, services],
  );

  const hasAny = series.some((s) => s.values.some((v) => Number.isFinite(v)));

  return (
    <section className="card" aria-labelledby="lat-h">
      <div className="card-head">
        <div>
          <h3 id="lat-h" className="card-title">
            Service latency
          </h3>
          <p className="card-sub">TCP connect time from this host, by service</p>
        </div>
      </div>

      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {latest.map((l, i) => (
          <div className="stat" key={l.id}>
            <span className="stat-label">
              <span className="swatch" style={{ background: SLOTS[i % SLOTS.length] }} aria-hidden="true" />
              {l.label}
            </span>
            <span className="stat-value" style={{ fontSize: 18 }}>
              {l.value === null ? 'down' : formatMs(l.value)}
            </span>
          </div>
        ))}
      </div>

      {hasAny ? (
        <TimeChart series={series} ariaLabel="Service probe latency over time" height={80} format={(v) => formatMs(v)} />
      ) : (
        <p className="empty">No probe latency recorded yet in this window.</p>
      )}
    </section>
  );
}
