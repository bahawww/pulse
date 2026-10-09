import { type JSX } from 'react';
import type { HistorySample, SystemMetrics } from '../shared/contract';
import { formatBytes, formatPercent, formatRate } from '../lib/format';
import { AnimatedNumber } from './AnimatedNumber';
import { Sparkline } from './Sparkline';

/**
 * Headline numbers. Each tile is the current reading, a meter, and the recent
 * shape from the same history the trend charts use, so the tile and the chart
 * can never disagree about what happened.
 */

interface TelemetryGridProps {
  readonly system: SystemMetrics | null;
  readonly samples: readonly HistorySample[];
}

function tone(percent: number): string {
  if (percent >= 90) return 'is-crit';
  if (percent >= 75) return 'is-warn';
  return '';
}

function sumRate(values: readonly (number | null)[]): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v !== null && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

export function TelemetryGrid({ system, samples }: TelemetryGridProps): JSX.Element {
  const cpu = system?.cpu.usage ?? 0;
  const mem = system?.memory.percent ?? 0;
  const disk = system?.disk.percent ?? 0;
  const rx = sumRate(system?.net.map((n) => n.rxPerSec) ?? []);
  const tx = sumRate(system?.net.map((n) => n.txPerSec) ?? []);

  const pick = (key: 'cpu' | 'ram' | 'disk' | 'netRx' | 'netTx'): number[] => samples.map((s) => s[key]);

  return (
    <section className="kpis" aria-label="Current readings">
      <article className="kpi">
        <div className="kpi-top">
          <span>CPU</span>
          <span className="tag">{system ? `${system.cpu.cores} cores` : '—'}</span>
        </div>
        <div>
          {system ? <AnimatedNumber className="kpi-value" value={cpu} format={formatPercent} /> : <span className="kpi-value">—</span>}
          <span className="kpi-unit">%</span>
        </div>
        <div className="meter" aria-hidden="true">
          <div className={`meter-fill ${tone(cpu)}`} style={{ width: `${Math.min(cpu, 100)}%`, background: tone(cpu) ? undefined : 'var(--s-cpu)' }} />
        </div>
        <Sparkline values={pick('cpu')} color="var(--s-cpu)" max={100} label="CPU over time" />
        <span className="kpi-sub">load {system?.cpu.load1m ?? '—'} · {system?.cpu.load5m ?? '—'} · {system?.cpu.load15m ?? '—'}</span>
      </article>

      <article className="kpi">
        <div className="kpi-top">
          <span>Memory</span>
          <span className="tag">RAM</span>
        </div>
        <div>
          {system ? <AnimatedNumber className="kpi-value" value={mem} format={formatPercent} /> : <span className="kpi-value">—</span>}
          <span className="kpi-unit">%</span>
        </div>
        <div className="meter" aria-hidden="true">
          <div className={`meter-fill ${tone(mem)}`} style={{ width: `${Math.min(mem, 100)}%`, background: tone(mem) ? undefined : 'var(--s-mem)' }} />
        </div>
        <Sparkline values={pick('ram')} color="var(--s-mem)" max={100} label="Memory over time" />
        <span className="kpi-sub">
          {system ? `${system.memory.used} of ${system.memory.total} · ${system.memory.free} free` : 'waiting for data'}
        </span>
      </article>

      <article className="kpi">
        <div className="kpi-top">
          <span>Root disk</span>
          <span className="tag">{system?.disk.mount ?? '/'}</span>
        </div>
        <div>
          {system ? <AnimatedNumber className="kpi-value" value={disk} format={formatPercent} /> : <span className="kpi-value">—</span>}
          <span className="kpi-unit">%</span>
        </div>
        <div className="meter" aria-hidden="true">
          <div className={`meter-fill ${tone(disk)}`} style={{ width: `${Math.min(disk, 100)}%`, background: tone(disk) ? undefined : 'var(--s-disk)' }} />
        </div>
        <Sparkline values={pick('disk')} color="var(--s-disk)" max={100} label="Disk over time" />
        <span className="kpi-sub">
          {system ? `${system.disk.used} of ${system.disk.total} · ${system.disk.free} free` : 'waiting for data'}
        </span>
      </article>

      <article className="kpi">
        <div className="kpi-top">
          <span>Network</span>
          <span className="tag">{system ? `${system.net.length} ifaces` : '—'}</span>
        </div>
        <div className="kpi-value kpi-value-sm">{formatRate(rx)}</div>
        <div className="kpi-sub">
          down · up {formatRate(tx)}
          {system?.net[0] ? ` · ${formatBytes(system.net[0].rxBytes)} rx total` : ''}
        </div>
        <Sparkline values={pick('netRx')} color="var(--s-rx)" label="Download over time" />
        <span className="kpi-sub">aggregate across real interfaces</span>
      </article>
    </section>
  );
}
