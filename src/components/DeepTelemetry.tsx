import { type JSX, useMemo } from 'react';
import type { HistorySample, SystemMetrics } from '../shared/contract';
import { formatBytes, formatPercent, formatRate } from '../lib/format';
import { TimeChart, type Series } from './TimeChart';

/**
 * Hardware detail: per-core load, memory, network interfaces with their
 * throughput history, and disk I/O. Each card reads the live snapshot; the
 * charts read the same history the trend card uses.
 */

interface DeepTelemetryProps {
  readonly system: SystemMetrics;
  readonly samples: readonly HistorySample[];
}

function meterTone(percent: number): string {
  if (percent >= 90) return 'is-crit';
  if (percent >= 75) return 'is-warn';
  return '';
}

export function DeepTelemetry({ system, samples }: DeepTelemetryProps): JSX.Element {
  const times = useMemo(() => samples.map((s) => s.t), [samples]);

  const cpuSeries = useMemo<Series[]>(
    () => [{ key: 'cpu', label: 'CPU', color: 'var(--s-cpu)', values: samples.map((s) => s.cpu), fill: true, times }],
    [samples, times],
  );

  const netSeries = useMemo<Series[]>(
    () => [
      { key: 'rx', label: 'Download', color: 'var(--s-rx)', values: samples.map((s) => s.netRx), fill: true, times },
      { key: 'tx', label: 'Upload', color: 'var(--s-tx)', values: samples.map((s) => s.netTx), times },
    ],
    [samples, times],
  );

  const cores = system.cpu.perCore;
  const busiest = cores.reduce((best, v, i) => (v > best.value ? { index: i, value: v } : best), { index: 0, value: 0 });
  const mem = system.memory;
  const swapPct = mem.swapTotalBytes > 0 ? (mem.swapUsedBytes / mem.swapTotalBytes) * 100 : 0;

  return (
    <div className="grid">
      <section className="card span-7" aria-labelledby="cores-h">
        <div className="card-head">
          <div>
            <h3 id="cores-h" className="card-title">
              CPU cores
            </h3>
            <p className="card-sub">
              {system.cpu.cores} logical · {system.cpu.model}
            </p>
          </div>
          <span className="tag">busiest core {formatPercent(busiest.value)}%</span>
        </div>

        <div className="cores" role="list" aria-label="Per-core CPU usage">
          {cores.map((v, i) => (
            <div className={`core${v >= 95 ? ' is-max' : v >= 75 ? ' is-hot' : ''}`} key={i} role="listitem">
              <div className="core-bar" title={`core ${i}: ${formatPercent(v)}%`}>
                <div className="core-fill" style={{ height: `${Math.min(Math.max(v, 0), 100)}%` }} />
              </div>
              <span>{i}</span>
            </div>
          ))}
        </div>

        <TimeChart series={cpuSeries} ariaLabel="Total CPU over time" height={72} max={100} format={formatPercent} />
        <p className="card-foot">
          load {system.cpu.load1m} · {system.cpu.load5m} · {system.cpu.load15m} (1m · 5m · 15m)
        </p>
      </section>

      <section className="card span-5" aria-labelledby="mem-h">
        <div className="card-head">
          <div>
            <h3 id="mem-h" className="card-title">
              Memory
            </h3>
            <p className="card-sub">available vs used</p>
          </div>
          <span className="tag">{formatPercent(mem.percent)}% used</span>
        </div>

        <div className="mem-bars">
          <div className="mem-bar-row">
            <div className="mem-bar-head">
              <span>RAM in use</span>
              <span className="mono">
                {formatPercent(mem.percent)}%
              </span>
            </div>
            <div className="meter">
              <div className={`meter-fill ${meterTone(mem.percent)}`} style={{ width: `${Math.min(mem.percent, 100)}%`, background: meterTone(mem.percent) ? undefined : 'var(--s-mem)' }} />
            </div>
          </div>
          <div className="mem-bar-row">
            <div className="mem-bar-head">
              <span>Swap</span>
              <span className="mono">{mem.swapTotalBytes > 0 ? `${formatPercent(swapPct)}%` : 'none'}</span>
            </div>
            <div className="meter">
              <div className={`meter-fill ${meterTone(swapPct)}`} style={{ width: `${Math.min(swapPct, 100)}%`, background: meterTone(swapPct) ? undefined : 'var(--s-lat)' }} />
            </div>
          </div>
        </div>

        <dl className="kv">
          <dt>In use</dt>
          <dd>{formatBytes(mem.usedBytes)} of {formatBytes(mem.totalBytes)}</dd>
          <dt>Available</dt>
          <dd>{formatBytes(mem.availableBytes)}</dd>
          <dt>Swap used</dt>
          <dd>
            {formatBytes(mem.swapUsedBytes)} of {formatBytes(mem.swapTotalBytes)}
          </dd>
        </dl>
      </section>

      <section className="card span-7" aria-labelledby="net-h">
        <div className="card-head">
          <div>
            <h3 id="net-h" className="card-title">
              Network
            </h3>
            <p className="card-sub">throughput per interface, aggregate history below</p>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {system.net.length === 0 && <p className="empty">No interfaces reported.</p>}
          {system.net.map((n) => (
            <div className="iface" key={n.name}>
              <div className="iface-head">
                <span className="mono">{n.name}</span>
                <span className="tag">{n.rxErrs + n.txErrs > 0 ? `${n.rxErrs + n.txErrs} errors` : 'clean'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className={`rate is-rx${n.rxPerSec === 0 ? ' is-idle' : ''}`}>↓ {formatRate(n.rxPerSec)}</span>
                <span className={`rate is-tx${n.txPerSec === 0 ? ' is-idle' : ''}`}>↑ {formatRate(n.txPerSec)}</span>
              </div>
              <span className="iface-foot">
                total {formatBytes(n.rxBytes)} in · {formatBytes(n.txBytes)} out
              </span>
            </div>
          ))}
        </div>

        <TimeChart series={netSeries} ariaLabel="Download and upload over time" height={72} format={(v) => formatRate(v)} />
      </section>

      <section className="card span-5" aria-labelledby="io-h">
        <div className="card-head">
          <div>
            <h3 id="io-h" className="card-title">
              Disk I/O
            </h3>
            <p className="card-sub">block devices, read and write rate</p>
          </div>
        </div>
        <div>
          {system.diskIo.length === 0 && <p className="empty">No block devices reported.</p>}
          {system.diskIo.map((d) => (
            <div className="io-row" key={d.name}>
              <span className="mono">{d.name}</span>
              <span style={{ display: 'flex', gap: 14 }}>
                <span className={`rate is-rx${d.readBytesPerSec === 0 ? ' is-idle' : ''}`}>↓ {formatRate(d.readBytesPerSec)}</span>
                <span className={`rate is-tx${d.writeBytesPerSec === 0 ? ' is-idle' : ''}`}>↑ {formatRate(d.writeBytesPerSec)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
