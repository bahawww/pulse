import { type JSX, useMemo, useState } from 'react';
import type { HistorySample, ProcessInfo, ProcessSignal } from '../shared/contract';
import { postJson } from '../lib/csrf';
import { formatBytes, formatPercent } from '../lib/format';
import { AskAgentButton } from './AskAgentButton';
import { TimeChart, type Series } from './TimeChart';

/**
 * Top processes by CPU right now, with the CPU history of the four busiest.
 * Chart series follow the process (by pid), not its row in the table, so a
 * line keeps its colour while the ranking shifts underneath it.
 */

interface ProcessHistoryProps {
  readonly processes: readonly ProcessInfo[];
  readonly samples: readonly HistorySample[];
  readonly canAct?: boolean;
  readonly onNotify?: (message: string) => void;
  readonly onRefresh?: () => void;
}

const SLOTS = ['var(--s-cpu)', 'var(--s-mem)', 'var(--s-disk)', 'var(--s-rx)'] as const;

const PROTECTED = new Set([
  'systemd',
  'init',
  'kthreadd',
  'sshd',
  'dockerd',
  'containerd',
  'containerd-shim',
  'tailscaled',
  'cloudflared',
  'fail2ban-server',
  'earlyoom',
  'mysqld',
  'mariadbd',
  'postgres',
  'redis-server',
  'Xtigervnc',
  '9router',
]);

interface PendingProc {
  readonly pid: number;
  readonly name: string;
  readonly signal: 'TERM' | 'KILL';
  readonly token: string;
}

export function ProcessHistory({ processes, samples, canAct = false, onNotify, onRefresh }: ProcessHistoryProps): JSX.Element {
  const times = useMemo(() => samples.map((s) => s.t), [samples]);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingProc | null>(null);

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

  const rows = processes.slice(0, 12);

  async function act(pid: number, name: string, signal: ProcessSignal, confirm?: string) {
    setBusyPid(pid);
    try {
      const res = await postJson('/api/performance/process', { pid, name, signal, ...(confirm ? { confirm } : {}) });
      const body = (await res.json()) as { ok: boolean; message: string; confirmToken?: string };
      if (!res.ok) {
        onNotify?.(body.message || `HTTP ${res.status}`);
        setPending(null);
        return;
      }
      if (body.confirmToken && (signal === 'TERM' || signal === 'KILL')) {
        setPending({ pid, name, signal, token: body.confirmToken });
        return;
      }
      onNotify?.(body.message);
      setPending(null);
      onRefresh?.();
    } catch {
      onNotify?.('Process action failed');
      setPending(null);
    } finally {
      setBusyPid(null);
    }
  }

  return (
    <section className="card" aria-labelledby="proc-h">
      <div className="card-head">
        <div>
          <h3 id="proc-h" className="card-title">
            Top processes
          </h3>
          <p className="card-sub">ranked by CPU, then memory{canAct ? ' · signal or renice active workloads' : ''}</p>
        </div>
        <span className="tw:flex tw:items-center tw:gap-2">
          <AskAgentButton
            prompt="Look at the top processes and the rest of this snapshot. Is anything misbehaving or using more than it should? Say what you would check or change first."
            context={[{ kind: 'metrics' }]}
            label="Ask agent"
          />
          <span className="tag">{processes.length} shown</span>
        </span>
      </div>

      {pending && (
        <div className="confirm" role="alertdialog" aria-labelledby="proc-confirm-h">
          <p id="proc-confirm-h">
            Send <strong>{pending.signal === 'KILL' ? 'SIGKILL (force kill)' : 'SIGTERM (graceful stop)'}</strong> to{' '}
            <strong>{pending.name}</strong> (PID {pending.pid})?
          </p>
          <div className="confirm-buttons">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busyPid === pending.pid}
              onClick={() => void act(pending.pid, pending.name, pending.signal, pending.token)}
            >
              {busyPid === pending.pid ? 'Working…' : `Yes, ${pending.signal} ${pending.name}`}
            </button>
            <button type="button" className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
                {canAct && (
                  <th scope="col" className="num">
                    Control
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const isProtected = PROTECTED.has(p.name) || p.pid <= 2;
                const isLowPrio = (p.nice ?? 0) > 0;
                return (
                  <tr key={p.pid}>
                    <td className="truncate" title={`${p.name} (pid ${p.pid})`}>
                      {p.name}
                      <span className="muted"> {p.pid}</span>
                      {(p.nice ?? 0) !== 0 && (
                        <span className="tag" style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px' }}>
                          nice {p.nice! > 0 ? `+${p.nice}` : p.nice}
                        </span>
                      )}
                    </td>
                    <td className="muted">{p.user}</td>
                    <td className="num">{formatPercent(p.cpuFraction * 100)}%</td>
                    <td className="num">{formatBytes(p.rssBytes)}</td>
                    {canAct && (
                      <td className="num">
                        {isProtected ? (
                          <span className="muted" style={{ fontSize: 11 }}>
                            protected
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 4 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 6px', fontSize: 11 }}
                              disabled={busyPid === p.pid}
                              title={isLowPrio ? 'Restore normal priority (nice 0)' : 'Lower CPU priority (renice +10)'}
                              onClick={() => void act(p.pid, p.name, isLowPrio ? 'NICE_NORMAL' : 'NICE_LOW')}
                            >
                              {isLowPrio ? 'Nice 0' : 'Nice +10'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 6px', fontSize: 11 }}
                              disabled={busyPid === p.pid}
                              title={`Send SIGTERM to ${p.name} (${p.pid})`}
                              onClick={() => void act(p.pid, p.name, 'TERM')}
                            >
                              Term
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger-ghost"
                              style={{ padding: '2px 6px', fontSize: 11 }}
                              disabled={busyPid === p.pid}
                              title={`Force kill ${p.name} (${p.pid}) with SIGKILL`}
                              onClick={() => void act(p.pid, p.name, 'KILL')}
                            >
                              Kill
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
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
