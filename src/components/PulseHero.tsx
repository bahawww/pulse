import { type JSX, type PointerEvent as ReactPointerEvent, type ReactNode, useMemo, useState } from 'react';
import type { HistorySample, SystemMetrics } from '../shared/contract';
import { formatClock } from '../lib/format';
import { formatUptime } from '../lib/urls';
import { AnimatedNumber } from './AnimatedNumber';
import { Bone } from './Skeleton';

const nowFormat = (v: number) => v.toFixed(v < 10 ? 1 : 0);

interface PulseHeroProps {
  readonly tone: '' | 'is-warn' | 'is-crit';
  readonly statusText: string;
  readonly system: SystemMetrics | null;
  readonly samples: readonly HistorySample[];
  /** "Updated 4s ago", rendered under the status line. */
  readonly freshness?: ReactNode;
}

const W = 1000;
const H = 150;
const TOP = 10;
const BOTTOM = 4;
const MAX_POINTS = 240;

/**
 * Overview opener: one sentence on the host's state, then its pulse, the CPU
 * trace from the same history the trend charts use. The newest reading carries
 * the only moving element on the page.
 */
export function PulseHero({ tone, statusText, system, samples, freshness }: PulseHeroProps): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const trace = useMemo(() => {
    const recent = samples.slice(-MAX_POINTS).filter((s) => Number.isFinite(s.cpu));
    const values = recent.map((s) => s.cpu);
    if (values.length < 2) return null;

    // Scale to the data with headroom, never below 25%, so a quiet host reads as quiet.
    const peak = Math.max(...values);
    const ceiling = Math.max(25, Math.ceil((peak * 1.3) / 5) * 5);
    const x = (i: number) => (i / (values.length - 1)) * W;
    const y = (v: number) => TOP + (1 - Math.min(v, ceiling) / ceiling) * (H - TOP - BOTTOM);

    const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const last = values[values.length - 1] ?? 0;
    const first = recent[0];
    const end = recent[recent.length - 1];
    const minutes = first && end ? Math.max(1, Math.round((end.t - first.t) / 60_000)) : 0;

    return {
      line,
      area: `${line} L${W} ${H - BOTTOM} L0 ${H - BOTTOM} Z`,
      ceiling,
      last,
      values,
      times: recent.map((s) => s.t),
      /** Point i as percentages of the plot box, for HTML overlays. */
      at: (i: number) => ({ left: (x(i) / W) * 100, top: (y(values[i] ?? 0) / H) * 100 }),
      minutes,
      midY: (y(ceiling / 2) / H) * 100,
      topY: (y(ceiling) / H) * 100,
      baseY: (y(0) / H) * 100,
    };
  }, [samples]);

  const lamp = tone || (system ? '' : 'is-idle');

  return (
    <section className="pulse" aria-labelledby="pulse-h">
      <div className="pulse-copy">
        <div>
          <h1 id="pulse-h" className="pulse-status">
            <span className={`lamp ${lamp}`} aria-hidden="true" />
            {statusText}
          </h1>
          {freshness && <p className="pulse-fresh">{freshness}</p>}
        </div>
        {!system && (
          <div className="pulse-facts" aria-hidden="true">
            {[96, 72, 120].map((w) => (
              <div key={w}>
                <Bone w={44} h={10} />
                <Bone w={w} h={14} style={{ marginTop: 6 }} />
              </div>
            ))}
          </div>
        )}
        {system && (
          <dl className="pulse-facts">
            <div>
              <dt>Host</dt>
              <dd>{system.hostname}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{formatUptime(system.uptime)}</dd>
            </div>
            <div>
              <dt>Kernel</dt>
              <dd>{system.kernel}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="trace">
        <div className="trace-head">
          <span className="trace-now">
            {trace ? (
              <>
                <AnimatedNumber value={trace.last} format={nowFormat} />%
              </>
            ) : (
              <Bone w={64} h={26} style={{ display: 'inline-block', verticalAlign: 'middle' }} />
            )}
            <small>CPU now</small>
          </span>
          <span className="trace-span">{trace ? `last ${trace.minutes} min` : 'collecting readings'}</span>
        </div>
        <div
          className="trace-plot"
          role="img"
          aria-label={trace ? `CPU usage over the last ${trace.minutes} minutes, now ${trace.last.toFixed(0)} percent` : 'CPU trace, waiting for data'}
        >
          {!trace && <Bone w="100%" h="100%" className="bone-chart" />}
          {trace && (
            <>
              {/* The plot and its scale sit side by side, so the line never runs under a label. */}
              <div
                className="trace-area"
                onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
                  setHover(Math.round(f * (trace.values.length - 1)));
                }}
                onPointerLeave={() => setHover(null)}
              >
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                  <line className="trace-grid" x1="0" x2={W} y1={H * (trace.topY / 100)} y2={H * (trace.topY / 100)} />
                  <line className="trace-grid" x1="0" x2={W} y1={H * (trace.midY / 100)} y2={H * (trace.midY / 100)} />
                  <line className="trace-base" x1="0" x2={W} y1={H * (trace.baseY / 100)} y2={H * (trace.baseY / 100)} />
                  <path className="trace-fill" d={trace.area} />
                  <path className="trace-line" d={trace.line} />
                </svg>
                {hover === null ? (
                  <span className="trace-dot" style={{ left: '100%', top: `${trace.at(trace.values.length - 1).top}%` }} aria-hidden="true" />
                ) : (
                  (() => {
                    const p = trace.at(hover);
                    const v = trace.values[hover] ?? 0;
                    const t = trace.times[hover];
                    return (
                      <>
                        <span className="trace-cross" style={{ left: `${p.left}%` }} aria-hidden="true" />
                        <span className="trace-dot is-hover" style={{ left: `${p.left}%`, top: `${p.top}%` }} aria-hidden="true" />
                        <span className={`trace-tip${p.left > 70 ? ' is-left' : ''}`} style={{ left: `${p.left}%`, top: `${p.top}%` }}>
                          <strong>{v.toFixed(v < 10 ? 1 : 0)}%</strong>
                          {t !== undefined && <span>{formatClock(t)}</span>}
                        </span>
                      </>
                    );
                  })()
                )}
              </div>
              <div className="trace-axis" aria-hidden="true">
                <span style={{ top: `${trace.topY}%` }}>{trace.ceiling}%</span>
                <span style={{ top: `${trace.midY}%` }}>{trace.ceiling / 2}%</span>
                <span style={{ top: `${trace.baseY}%` }}>0</span>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
