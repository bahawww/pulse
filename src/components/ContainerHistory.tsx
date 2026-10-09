import { type JSX, useMemo } from 'react';
import { isHiddenContainer, type DockerContainer, type HistorySample } from '../shared/contract';
import { formatBytes, formatPercent } from '../lib/format';
import { TimeChart, type Series } from './TimeChart';

/**
 * Docker containers: live state per container, plus memory history for the
 * four largest. The list is what the engine reports now; the chart is what the
 * containers used over the selected range.
 */

interface ContainerHistoryProps {
  readonly containers: readonly DockerContainer[];
  readonly samples: readonly HistorySample[];
}

const SLOTS = ['var(--s-cpu)', 'var(--s-mem)', 'var(--s-disk)', 'var(--s-rx)'] as const;

function isRunning(c: DockerContainer): boolean {
  return c.state === 'running';
}

export function ContainerHistory({ containers, samples }: ContainerHistoryProps): JSX.Element {
  const times = useMemo(() => samples.map((s) => s.t), [samples]);

  const topIds = useMemo(() => {
    const latest = samples[samples.length - 1]?.containers ?? {};
    return Object.entries(latest)
      .filter(([, c]) => !isHiddenContainer(c.name))
      .sort(([, a], [, b]) => b.memBytes - a.memBytes)
      .slice(0, SLOTS.length)
      .map(([id, c]) => ({ id, name: c.name }));
  }, [samples]);

  const series = useMemo<Series[]>(
    () =>
      topIds.map((c, i) => ({
        key: c.id,
        label: c.name,
        color: SLOTS[i] ?? 'var(--accent)',
        values: samples.map((s) => s.containers?.[c.id]?.memBytes ?? Number.NaN),
        times,
      })),
    [samples, times, topIds],
  );

  return (
    <section className="card" aria-labelledby="ct-h">
      <div className="card-head">
        <div>
          <h3 id="ct-h" className="card-title">
            Containers
          </h3>
          <p className="card-sub">Docker engine, {containers.length} total</p>
        </div>
        <span className="tag">{containers.filter(isRunning).length} running</span>
      </div>

      {containers.length === 0 ? (
        <p className="empty">No containers reported. Docker may be off or the socket unreadable.</p>
      ) : (
        <ul className="ct-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {containers.map((c) => (
            <li className="ct-row" key={c.id}>
              <span className={`state-dot ${isRunning(c) ? (c.health === 'unhealthy' ? 'is-bad' : 'is-up') : ''}`} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <div className="ct-name" title={c.name}>
                  {c.name}
                </div>
                <div className="ct-image" title={c.image}>
                  {c.image} · {c.status}
                  {c.restartCount > 0 ? ` · ${c.restartCount} restarts` : ''}
                </div>
              </div>
              <div className="ct-stats">
                <div>{isRunning(c) ? `${formatPercent(c.cpuPercent)}%` : '—'}</div>
                <div className="muted">{c.memBytes > 0 ? formatBytes(c.memBytes) : '—'}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {series.length > 0 && (
        <>
          <p className="card-sub">memory over time, four largest right now</p>
          <TimeChart series={series} ariaLabel="Container memory over time" height={64} format={(v) => formatBytes(v)} />
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
