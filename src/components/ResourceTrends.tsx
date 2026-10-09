import { type CSSProperties, type JSX, useMemo, useState } from 'react';
import type { HistorySample, TimeRangeId } from '../shared/contract';
import { formatPercent } from '../lib/format';
import { RangePicker } from './RangePicker';
import { TimeChart, type Series } from './TimeChart';

/**
 * Trend card: one chart, three metrics.
 *
 * The three stat tiles are the selector. "All" overlays the three on a fixed
 * 0-100 scale (honest about absolute load); picking one metric rescales the
 * chart to that metric's own range, so a flat 9% disk line is still readable.
 * One 150px plot replaces the old stack of four charts.
 */

interface ResourceTrendsProps {
  readonly samples: readonly HistorySample[];
  readonly range: TimeRangeId;
  readonly onRangeChange: (range: TimeRangeId) => void;
  readonly maxSpanMs: number;
  readonly ready: boolean;
  readonly persisted?: boolean | undefined;
  readonly persistError?: string | null | undefined;
}

type TrendKey = 'cpu' | 'ram' | 'disk';
type Focus = 'all' | TrendKey;

const METRICS: readonly { readonly key: TrendKey; readonly label: string; readonly color: string }[] = [
  { key: 'cpu', label: 'CPU', color: 'var(--s-cpu)' },
  { key: 'ram', label: 'Memory', color: 'var(--s-mem)' },
  { key: 'disk', label: 'Disk', color: 'var(--s-disk)' },
];

function stat(values: readonly number[]): { last: number; avg: number; peak: number } {
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    count += 1;
    if (v > peak) peak = v;
  }
  const last = values[values.length - 1] ?? Number.NaN;
  return { last, avg: count > 0 ? sum / count : 0, peak };
}

export function ResourceTrends({
  samples,
  range,
  onRangeChange,
  maxSpanMs,
  ready,
  persisted,
  persistError,
}: ResourceTrendsProps): JSX.Element {
  const [focus, setFocus] = useState<Focus>('all');
  const times = useMemo(() => samples.map((s) => s.t), [samples]);

  const series = useMemo<Series[]>(
    () =>
      METRICS.map((m) => ({
        key: m.key,
        label: m.label,
        color: m.color,
        values: samples.map((s) => s[m.key]),
        times,
      })),
    [samples, times],
  );

  const shown = useMemo<Series[]>(
    () => (focus === 'all' ? series : series.filter((s) => s.key === focus)).map((s) => ({ ...s, fill: true })),
    [series, focus],
  );

  const hasData = samples.length > 1;
  const fit = focus !== 'all';
  const focusLabel = METRICS.find((m) => m.key === focus)?.label ?? '';

  return (
    <section className="card" aria-labelledby="trends-h">
      <div className="toolbar">
        <div>
          <h3 id="trends-h" className="card-title">
            Resource trends
          </h3>
          <p className="card-sub">
            {fit ? `${focusLabel} only, scale fits the data` : 'all three, fixed 0–100% scale'} · drag to pan, shift-drag
            to zoom
          </p>
        </div>
        <RangePicker
          value={range}
          onChange={onRangeChange}
          maxSpanMs={maxSpanMs}
          ready={ready}
          persisted={persisted}
          persistError={persistError}
        />
      </div>

      {!hasData ? (
        <p className="empty">Collecting samples. The first trend lines appear after a few seconds.</p>
      ) : (
        <>
          <div className="stats" role="group" aria-label="Choose metric">
            {series.map((s) => {
              const { last, avg, peak } = stat(s.values);
              const active = focus === s.key;
              return (
                <button
                  type="button"
                  key={s.key}
                  className={`stat stat-btn${active ? ' is-active' : ''}`}
                  style={{ '--stat-color': s.color } as CSSProperties}
                  aria-pressed={active}
                  onClick={() => setFocus(active ? 'all' : (s.key as TrendKey))}
                  title={active ? 'Click to show all three again' : `Show ${s.label} only`}
                >
                  <span className="stat-label">
                    <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                    {s.label}
                  </span>
                  <span className="stat-value">
                    {Number.isFinite(last) ? formatPercent(last) : '—'}
                    <small>%</small>
                  </span>
                  <span className="stat-sub">
                    avg {formatPercent(avg)} · peak {formatPercent(peak)}
                  </span>
                </button>
              );
            })}
          </div>

          <TimeChart
            key={focus}
            series={shown}
            ariaLabel={fit ? `${focusLabel} utilisation over time` : 'CPU, memory and disk utilisation over time'}
            height={150}
            {...(fit ? {} : { max: 100 })}
            format={formatPercent}
          />
        </>
      )}
    </section>
  );
}
