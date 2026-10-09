import { type JSX, useMemo } from 'react';
import type { HistorySample, ProcessInfo } from '../shared/contract';
import { formatBytes, formatPercent } from '../lib/format';
import { TimeChart, type Series } from './TimeChart';

/**
 * Top processes by CPU right now, with the CPU history of the four busiest.
 * Chart series follow the process (by pid), not its row in the table, so a
 * line keeps its colour while the ranking shifts underneath it.
 */

interface ProcessHistoryProps {
  readonly processes: readonly ProcessInfo[];
  readonly samples: readonly HistorySample[];
}

const SLOTS = ['var(--s-cpu)', 'var(--s-mem)', 'var(--s-disk)', 'var(--s-rx)'] as const;

export function ProcessHistory({ processes, samples }: ProcessHistoryProps): JSX.Element {
  const times = useMemo(() => samples.map((s) => s.t), [samples]);

  const topPids = useMemo(() => {
    const latest = samples[samples.length - 1]?.processes ?? {};
    return Object.entries(latest)
      .sort(([, a], [, b]) => b.cpuFraction - a.cpuFraction)
      .slice(0, SLOTS.length)
      .map(([pid, p]) => ({ pid, name: p.name }));
  }, [samples]);

  const series = useMemo<Series[]>(
    () =>
      topPids.map((p, i) => ({
        key: p.pid,
        label: `${p.name} ${p.pid}`,
        color: SLOTS[i] ?? 'var(--accent)',
        values: samples.map((s) => {
          const sample = s.processes?.[p.pid];
          return sample ? sample.cpuFraction * 100 : Number.NaN;
        }),
        times,
      })),
    [samples, times, topPids],
  );

  const rows = processes.slice(0, 10);

  return (
    <section className="card" aria-labelledby="proc-h">
      <div className="card-head">
        <div>
          <h3 id="proc-h" className="card-title">
            Top processes
          </h3>
          <p className="card-sub">ranked by CPU, then memory</p>
        </div>
        <span className="tag">{processes.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No process data.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table proc-table">
            <thead>
              <tr>
                <th scope="col">Process</th>
                <th scope="col">User</th>
                <th scope="col" className="num">
                  CPU
                </th>
                <th scope="col" className="num">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.pid}>
                  <td className="truncate" title={`${p.name} (pid ${p.pid})`}>
                    {p.name}
                    <span className="muted"> {p.pid}</span>
                  </td>
                  <td className="muted">{p.user}</td>
                  <td className="num">{formatPercent(p.cpuFraction * 100)}%</td>
                  <td className="num">{formatBytes(p.rssBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {series.length > 0 && (
        <>
          <p className="card-sub">CPU over time, four busiest right now</p>
          <TimeChart series={series} ariaLabel="CPU of the busiest processes over time" height={64} format={(v) => `${formatPercent(v)}%`} />
          <div className="legend">
            {series.map((s) => (
              <span className="legend-item" key={s.key}>
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
