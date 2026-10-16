import { type CSSProperties, type JSX, useMemo, useState } from 'react';
import { TIME_RANGES, type HistorySample, type TimeRangeId } from '../shared/contract';
import { formatPercent } from '../lib/format';
import { RangePicker } from './RangePicker';
import { Bone, Loading } from './Skeleton';
import { TimeChart, type Series } from './TimeChart';

/**
 * Trend card: one chart, three metrics.
 *
 * The three stat tiles are the selector. "All" overlays the three lines on a
 * fixed 0-100 scale (honest about absolute load); picking one metric fills it
 * and rescales the chart to that metric's own range, so a flat 9% disk line is
 * still readable. One plot replaces the old stack of four charts.
 */

interface ResourceTrendsProps {
  readonly samples: readonly HistorySample[];
  readonly range: TimeRangeId;
  readonly onRangeChange: (range: TimeRangeId) => void;
  readonly maxSpanMs: number;
  readonly ready: boolean;
  readonly persisted?: boolean | undefined;
  readonly persistError?: string | null | undefined;
  /** A chosen range still loading (see useHistory). */
  readonly pending?: TimeRangeId | null | undefined;
}

type TrendKey = 'cpu' | 'ram' | 'disk';
type Focus = 'all' | TrendKey;

const METRICS: readonly { readonly key: TrendKey; readonly label: string; readonly color: string }[] = [
  { key: 'cpu', label: 'CPU', color: 'var(--s-cpu)' },
  { key: 'ram', label: 'Memory', color: 'var(--s-mem)' },
  { key: 'disk', label: 'Disk', color: 'var(--s-disk)' },
];

/** Plot height in px; tall enough that a 5% wiggle is visible. */
const CHART_HEIGHT = 210;

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
  pending,
}: ResourceTrendsProps): JSX.Element {
  const [focus, setFocus] = useState<Focus>('all');
  // After the first switch the chart only crossfades (motion.css), it does not replay its entrance.
  const [refocused, setRefocused] = useState(false);
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

  // Three overlapping fills turn to mud: "all" draws lines, one metric gets its area.
  const shown = useMemo<Series[]>(
    () => (focus === 'all' ? series : series.filter((s) => s.key === focus).map((s) => ({ ...s, fill: true }))),
    [series, focus],
  );

  const hasData = samples.length > 1;
  const fit = focus !== 'all';
  const focusLabel = METRICS.find((m) => m.key === focus)?.label ?? '';
  const rangeLabel = TIME_RANGES.find((r) => r.id === range)?.label ?? '';
  // Focused, the axis tops out at a round 10% above the peak (0/40/80, not 0/41/81).
  const focusPeak = fit ? stat(series.find((s) => s.key === focus)?.values ?? []).peak : 0;
  const focusCeiling = Math.min(100, Math.max(10, Math.ceil((focusPeak * 1.15) / 10) * 10));

  return (
    <section className="card" aria-labelledby="trends-h">
      <div className="toolbar">
        <div>
          <h3 id="trends-h" className="card-title">
            Resource trends
          </h3>
          <p className="card-sub">
            {fit ? `${focusLabel} only, scale fits the data. Click it again for all three.` : 'All three on a fixed 0–100% scale. Click a metric to focus it.'}
          </p>
        </div>
        <RangePicker
          value={range}
          onChange={onRangeChange}
          maxSpanMs={maxSpanMs}
          ready={ready}
          persisted={persisted}
          persistError={persistError}
          pending={pending}
        />
      </div>

      {!hasData && !ready ? (
        <Loading what="trends">
          <div className="bone-row" style={{ borderTop: 0, gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <Bone key={i} h={56} style={{ flex: 1 }} />
            ))}
          </div>
          <Bone h={CHART_HEIGHT + 16} className="bone-chart" />
        </Loading>
      ) : !hasData ? (
        <p className="empty">Collecting samples. The first trend lines appear after a few seconds.</p>
      ) : (
        <>
          <div className={`stats${fit ? ' has-focus' : ''}`} role="group" aria-label="Choose metric">
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
                  onClick={() => {
                    setRefocused(true);
                    setFocus(active ? 'all' : (s.key as TrendKey));
                  }}
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
                  <span className="stat-meter" aria-hidden="true">
                    <i style={{ transform: `scaleX(${Number.isFinite(last) ? Math.min(1, Math.max(0, last / 100)) : 0})` }} />
                  </span>
                  <span className="stat-sub">
                    {rangeLabel} avg {formatPercent(avg)} · peak {formatPercent(peak)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className={refocused ? 'is-refocused' : undefined}>
            <TimeChart
              key={focus}
              series={shown}
              ariaLabel={fit ? `${focusLabel} utilisation over time` : 'CPU, memory and disk utilisation over time'}
              height={CHART_HEIGHT}
              {...(fit ? { domainMax: focusCeiling } : { max: 100 })}
              format={formatPercent}
            />
          </div>
        </>
      )}
    </section>
  );
}
