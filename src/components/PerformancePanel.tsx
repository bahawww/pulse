import { type JSX, useState } from 'react';
import { usePolled } from '../hooks/usePolled';
import { postJson, sendJson } from '../lib/csrf';
import { formatAgo, formatBytes } from '../lib/format';
import { fill } from '../lib/meter';
import { SelectMenu, type SelectOption } from './SelectMenu';
import type { MaintenanceSchedule, MaintenanceTask, PerformanceState, ResourceLimitTarget } from '../shared/contract';

/**
 * Interactive Server Performance Management (#2) & Automated Guardrails (#3):
 *  - System Maintenance: one-click kernel cache drop, Docker cache prune,
 *    journald vacuum, and failed systemd unit reset with 2-phase confirmation.
 *  - Automated Schedule switches: weekly Docker prune, weekly journal vacuum,
 *    and automatic cache drop when RAM exceeds 85%.
 *  - Live Cgroup Resource Guardrails: inspect and update MemoryHigh/MemoryMax
 *    and CPUQuota across systemd system and user services.
 */

const MEM_OPTIONS: readonly { label: string; mb: number | null }[] = [
  { label: 'Uncapped', mb: null },
  { label: '512 MB', mb: 512 },
  { label: '1 GB', mb: 1024 },
  { label: '1.5 GB', mb: 1536 },
  { label: '2 GB', mb: 2048 },
  { label: '3 GB', mb: 3072 },
  { label: '4 GB', mb: 4096 },
];

const CPU_OPTIONS: readonly { label: string; pct: number | null }[] = [
  { label: 'Uncapped', pct: null },
  { label: '1 core', pct: 100 },
  { label: '2 cores', pct: 200 },
  { label: '4 cores', pct: 400 },
  { label: '8 cores', pct: 800 },
];

/**
 * Menu options for one row. A value set outside Pulse (systemctl, a drop-in)
 * that matches no preset is listed as its own entry, so the menu shows it
 * instead of a blank button.
 */
function memOptions(current: number | null): SelectOption[] {
  const list: SelectOption[] = MEM_OPTIONS.map((o) => ({ value: o.mb === null ? '' : String(o.mb), label: o.label }));
  if (current !== null && !MEM_OPTIONS.some((o) => o.mb === current)) list.push({ value: String(current), label: `${current} MB (custom)` });
  return list;
}

function cpuOptions(current: number | null): SelectOption[] {
  const list: SelectOption[] = CPU_OPTIONS.map((o) => ({ value: o.pct === null ? '' : String(o.pct), label: o.label }));
  if (current !== null && !CPU_OPTIONS.some((o) => o.pct === current)) list.push({ value: String(current), label: `${current}% (custom)` });
  return list;
}

const KIND_LABEL: Readonly<Record<ResourceLimitTarget['kind'], string>> = {
  'systemd-system': 'system',
  'systemd-user': 'user',
  docker: 'docker',
};

const POLICIES: readonly { key: keyof Pick<MaintenanceSchedule, 'autoDropCacheOnPressure' | 'autoDockerPruneWeekly' | 'autoJournalVacuumWeekly'>; label: string; hint: string }[] = [
  { key: 'autoDropCacheOnPressure', label: 'Drop caches under memory pressure', hint: 'when RAM in use reaches 85%' },
  { key: 'autoDockerPruneWeekly', label: 'Prune Docker cache weekly', hint: 'unused images and build cache' },
  { key: 'autoJournalVacuumWeekly', label: 'Vacuum system logs weekly', hint: 'journald down to 100 MB / 7 days' },
];

interface TaskMeta {
  readonly id: MaintenanceTask;
  readonly label: string;
  readonly hint: string;
}

const TASKS: readonly TaskMeta[] = [
  { id: 'drop-caches', label: 'Drop kernel caches', hint: 'frees page and slab cache (sync, then drop_caches)' },
  { id: 'docker-prune', label: 'Prune Docker cache', hint: 'dangling images and build cache; volumes are kept' },
  { id: 'journal-vacuum', label: 'Vacuum system logs', hint: 'trims archived journald logs to 100 MB / 7 days' },
  { id: 'reset-failed', label: 'Clear failed units', hint: 'resets the failed state of system and user units' },
];

function bytesToNearestMB(bytes: number | null): number | null {
  if (bytes === null || bytes <= 0) return null;
  const mb = Math.round(bytes / (1024 * 1024));
  const hit = MEM_OPTIONS.find((o) => o.mb !== null && Math.abs(o.mb - mb) <= 64);
  return hit ? hit.mb : mb;
}

export function PerformancePanel({ onNotify }: { readonly onNotify: (message: string) => void }): JSX.Element {
  const perf = usePolled<PerformanceState>('/api/performance', 30_000, true);
  const [pendingTask, setPendingTask] = useState<{ task: TaskMeta; token: string } | null>(null);
  const [busyTask, setBusyTask] = useState<MaintenanceTask | null>(null);
  const [taskResult, setTaskResult] = useState<{ ok: boolean; message: string; durationMs: number } | null>(null);
  const [savingUnit, setSavingUnit] = useState<string | null>(null);

  async function runMaintenance(task: TaskMeta, token?: string) {
    setBusyTask(task.id);
    try {
      const res = await postJson('/api/performance/maintenance', { task: task.id, ...(token ? { confirm: token } : {}) });
      const body = (await res.json()) as { ok: boolean; message: string; durationMs: number; confirmToken?: string };
      if (!res.ok) {
        setTaskResult({ ok: false, message: body.message || `HTTP ${res.status}`, durationMs: 0 });
        setPendingTask(null);
        return;
      }
      if (body.confirmToken) {
        setPendingTask({ task, token: body.confirmToken });
        setTaskResult(null);
        return;
      }
      setTaskResult({ ok: body.ok, message: body.message, durationMs: body.durationMs });
      setPendingTask(null);
      onNotify(body.message);
      perf.refresh();
    } catch {
      setTaskResult({ ok: false, message: 'Maintenance request failed', durationMs: 0 });
      setPendingTask(null);
    } finally {
      setBusyTask(null);
    }
  }

  async function toggleSchedule(patch: Partial<MaintenanceSchedule>) {
    try {
      const res = await sendJson('PUT', '/api/performance/schedule', patch);
      if (res.ok) {
        onNotify('Automated maintenance policy saved');
        perf.refresh();
      } else {
        onNotify('Could not save schedule');
      }
    } catch {
      onNotify('Could not save schedule');
    }
  }

  async function saveUnitLimit(target: ResourceLimitTarget, memoryMaxMB: number | null, cpuQuotaPercent: number | null) {
    setSavingUnit(target.id);
    try {
      const res = await postJson('/api/performance/limits', {
        id: target.id,
        memoryMaxMB,
        cpuQuotaPercent,
      });
      const body = (await res.json()) as { ok: boolean; message: string };
      onNotify(body.message || (res.ok ? 'Limit updated' : 'Failed to update limit'));
      perf.refresh();
    } catch {
      onNotify('Failed to update service limit');
    } finally {
      setSavingUnit(null);
    }
  }

  const data = perf.data;
  const sched = data?.schedule;

  return (
    <div className="grid" style={{ marginTop: 16 }}>
      <section className="card span-5" aria-labelledby="maint-h">
        <div className="card-head">
          <div>
            <h3 id="maint-h" className="card-title">
              System maintenance
            </h3>
            <p className="card-sub">reclaim memory and disk now, or on a schedule</p>
          </div>
          {data && data.reclaimableCacheBytes > 0 && (
            <span className="tag" title="Page cache, buffers and reclaimable slab">
              {formatBytes(data.reclaimableCacheBytes)} cached
            </span>
          )}
        </div>

        {pendingTask && (
          <div className="confirm" role="alertdialog" aria-labelledby="maint-confirm-h">
            <p id="maint-confirm-h">
              Run <strong>{pendingTask.task.label}</strong> on this host?
              <br />
              <span className="muted" style={{ fontSize: 12 }}>
                {pendingTask.task.hint}
              </span>
            </p>
            <div className="confirm-buttons">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyTask !== null}
                onClick={() => void runMaintenance(pendingTask.task, pendingTask.token)}
              >
                {busyTask ? 'Working…' : `Yes, ${pendingTask.task.label.toLowerCase()}`}
              </button>
              <button type="button" className="btn" onClick={() => setPendingTask(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {taskResult && (
          <div className={`result ${taskResult.ok ? 'is-ok' : 'is-error'}`} role="status">
            <p>{taskResult.message}</p>
            {taskResult.durationMs > 0 && <p className="card-foot">took {taskResult.durationMs} ms</p>}
          </div>
        )}

        <ul className="maint-list">
          {TASKS.map((t) => {
            const last = sched?.lastRunAt[t.id];
            return (
              <li className="maint-row" key={t.id}>
                <span className="maint-text">
                  <span className="maint-label">{t.label}</span>
                  <span className="maint-hint">
                    {t.hint}
                    {last ? ` · ran ${formatAgo(Date.now() - last)}` : ''}
                  </span>
                </span>
                <button type="button" className="btn btn-sm" disabled={busyTask !== null} onClick={() => void runMaintenance(t)}>
                  {busyTask === t.id ? 'Running…' : 'Run'}
                </button>
              </li>
            );
          })}
        </ul>

        {sched && (
          <div className="maint-policies">
            <p className="maint-section">Automatic</p>
            <div className="maint-list">
              {POLICIES.map((p) => (
                <label className="maint-row is-toggle" key={p.key}>
                  <span className="maint-text">
                    <span className="maint-label">{p.label}</span>
                    <span className="maint-hint">{p.hint}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={sched[p.key]}
                    onChange={(e) => void toggleSchedule({ [p.key]: e.currentTarget.checked })}
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card span-7" aria-labelledby="guard-h">
        <div className="card-head">
          <div>
            <h3 id="guard-h" className="card-title">
              Service resource limits
            </h3>
            <p className="card-sub">systemd MemoryMax and CPUQuota per service, kept across restarts</p>
          </div>
        </div>

        {!data ? (
          <p className="empty">Loading service limits…</p>
        ) : (
          <div className="guard" role="table" aria-label="Service resource limits">
            <div className="guard-row guard-head" role="row">
              <span role="columnheader">Service</span>
              <span role="columnheader" className="num">
                RAM now
              </span>
              <span role="columnheader">Memory cap</span>
              <span role="columnheader">CPU cap</span>
            </div>
            {data.limits.map((u) => {
              const curMemMB = bytesToNearestMB(u.memoryMaxBytes);
              const curCpu = u.cpuQuotaPercent;
              const isBusy = savingUnit === u.id;
              const capPct = u.memoryMaxBytes ? (u.currentBytes / u.memoryMaxBytes) * 100 : null;
              return (
                <div className={`guard-row${isBusy ? ' is-busy' : ''}`} role="row" key={u.id}>
                  <span className="guard-name" role="cell">
                    <span className="guard-label">{u.label}</span>
                    <span className="guard-id" title={u.id}>
                      {u.id} · {KIND_LABEL[u.kind]}
                    </span>
                  </span>
                  <span className="guard-ram num" role="cell">
                    <span className="mono">{u.currentBytes > 0 ? formatBytes(u.currentBytes) : '—'}</span>
                    {capPct !== null && (
                      <span className="meter guard-meter" title={`${Math.round(capPct)}% of the cap`}>
                        <span className={`meter-fill${capPct >= 90 ? ' is-crit' : capPct >= 75 ? ' is-warn' : ''}`} style={fill(capPct, capPct >= 75 ? undefined : 'var(--s-mem)')} />
                      </span>
                    )}
                    {u.memoryHighBytes ? <span className="guard-sub mono">high {formatBytes(u.memoryHighBytes)}</span> : null}
                  </span>
                  <span className="guard-cell" role="cell" data-label="Memory cap">
                    <SelectMenu
                      label={`Memory cap for ${u.label}`}
                      value={curMemMB === null ? '' : String(curMemMB)}
                      options={memOptions(curMemMB)}
                      disabled={isBusy}
                      onChange={(v) => void saveUnitLimit(u, v === '' ? null : Number(v), curCpu)}
                    />
                  </span>
                  <span className="guard-cell" role="cell" data-label="CPU cap">
                    <SelectMenu
                      label={`CPU cap for ${u.label}`}
                      value={curCpu === null ? '' : String(curCpu)}
                      options={cpuOptions(curCpu)}
                      disabled={isBusy}
                      onChange={(v) => void saveUnitLimit(u, curMemMB, v === '' ? null : Number(v))}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
