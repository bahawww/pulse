import { useState } from 'react';
import { usePolled } from '../hooks/usePolled';
import type { ActionLogEntry, ActionResult, ActionTarget } from '../shared/contract';

/**
 * Service control. Two deliberate friction points, because this panel can take
 * the box down:
 *
 *  1. Two-phase confirmation. The first click acts on nothing. The server
 *     answers with a short-lived token, and only a second request echoing that
 *     token runs the action. A stray click or a cross-site post restarts nothing.
 *  2. Targets come from what the server observed, never typed. There is no
 *     free-text field; the server allowlist would reject one anyway.
 */

interface Target {
  readonly target: ActionTarget;
  readonly name: string;
  readonly label: string;
  /** Drives which buttons make sense: Start only when stopped, Restart and Stop only when running. */
  readonly running: boolean;
}

type Verb = 'restart' | 'stop' | 'start';

interface Pending {
  readonly target: Target;
  readonly action: Verb;
  readonly token: string;
}

export function ActionsPanel({
  systemdTargets,
  dockerTargets,
}: {
  readonly systemdTargets: readonly { readonly id: string; readonly running: boolean }[];
  readonly dockerTargets: readonly { readonly id: string; readonly name: string; readonly running: boolean }[];
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  // The audit log comes from SQLite, so it survives restarts. Refetched after
  // every request, because the log only changes when an action actually ran.
  const log = usePolled<{ readonly entries: readonly ActionLogEntry[] }>('/api/actions/log', 60_000);

  const targets: Target[] = [
    ...dockerTargets.map<Target>((c) => ({ target: 'docker', name: c.name, label: c.name, running: c.running })),
    ...systemdTargets.map<Target>((u) => ({ target: 'systemd', name: u.id, label: u.id, running: u.running })),
  ];

  async function post(target: Target, action: Verb, token?: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target.target, name: target.name, action, ...(token ? { confirm: token } : {}) }),
      });
      const body = (await res.json()) as ActionResult & { confirmToken?: string };

      if (!res.ok) {
        setResult({ ...body, message: body.message || `HTTP ${res.status}` });
        setPending(null);
        return;
      }

      if (body.confirmToken) {
        // Phase one. Nothing has happened yet; we hold a token.
        setPending({ target, action, token: body.confirmToken });
        setResult(null);
        return;
      }

      setResult(body);
      setPending(null);
    } catch {
      setResult({
        ok: false,
        target: target.target,
        name: target.name,
        action,
        message: 'Request failed. Is the dashboard still running?',
        stdout: '',
        durationMs: 0,
      });
      setPending(null);
    } finally {
      setBusy(false);
      log.refresh();
    }
  }

  return (
    <section className="card" aria-labelledby="actions-h">
      <div className="card-head">
        <div>
          <h3 id="actions-h" className="card-title">
            Service control
          </h3>
          <p className="card-sub">start, stop or restart real services on this host</p>
        </div>
        <span className="pill is-warn">writes to host</span>
      </div>

      {pending && (
        <div className="confirm" role="alertdialog" aria-labelledby="confirm-h">
          <p id="confirm-h">
            {pending.action === 'stop' ? 'Stop' : pending.action === 'start' ? 'Start' : 'Restart'} <strong>{pending.target.label}</strong>
            {pending.target.target === 'docker' ? ' (container)' : ' (systemd unit)'} on this host?
            {pending.action === 'stop' && ' It stays down until someone starts it again.'}
          </p>
          <div className="confirm-buttons">
            <button
              type="button"
              className={`btn ${pending.action === 'start' ? 'btn-primary' : 'btn-danger'}`}
              disabled={busy}
              onClick={() => void post(pending.target, pending.action, pending.token)}
            >
              {busy ? 'Working…' : `Yes, ${pending.action} ${pending.target.label}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setResult(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className={`result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
          <p>{result.message}</p>
          {result.stdout && <pre>{result.stdout.slice(0, 400)}</pre>}
          <p className="card-foot">took {result.durationMs} ms</p>
        </div>
      )}

      {targets.length === 0 ? (
        <p className="empty">No controllable targets yet. They appear after the first poll.</p>
      ) : (
        <ul className="action-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {targets.map((t) => (
            <li className="action-row" key={`${t.target}-${t.name}`}>
              <span className="action-kind">{t.target}</span>
              <span className="action-name" title={t.name}>
                {t.label}
              </span>
              <span className="action-buttons">
                {/* Every verb stays available. The running state comes from a health probe, which can
                    be wrong for a moment, and a wrong probe must never lock out a restart. Start is only
                    highlighted when the service looks down. */}
                <button
                  type="button"
                  className={`btn btn-sm${t.running ? '' : ' btn-primary'}`}
                  disabled={busy}
                  title={t.running ? `${t.label} looks up. Start does nothing if it already runs.` : `Start ${t.label}`}
                  onClick={() => void post(t, 'start')}
                >
                  Start
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} title={`Restart ${t.label}`} onClick={() => void post(t, 'restart')}>
                  Restart
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  disabled={busy}
                  title={`Stop ${t.label}`}
                  onClick={() => void post(t, 'stop')}
                >
                  Stop
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {log.data && log.data.entries.length > 0 && (
        <div>
          <p className="card-sub" style={{ marginBottom: 8 }}>
            Recent actions
          </p>
          <ul className="action-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {log.data.entries.slice(0, 5).map((e) => (
              <li className="action-row" key={e.id}>
                <span className="action-kind">
                  {new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
                <span className="action-name" title={e.message}>
                  {e.action} {e.name}
                </span>
                <span className={`pill ${e.ok ? 'is-ok' : 'is-crit'}`}>{e.ok ? 'ok' : 'failed'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
