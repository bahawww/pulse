import { type JSX, useEffect, useRef, useState } from 'react';
import type { AlertsHandle } from '../hooks/useAlerts';
import { formatAgo, formatPercent } from '../lib/format';
import { BellIcon } from './icons';
import type { AlertEvent, AlertState } from '../shared/contract';

/**
 * Alerts bell. The badge counts only what is firing now; resolved events stay
 * in the popover but never light the badge. Delivery is web-only: this popover,
 * a toast and an optional desktop notification while the dashboard is open.
 */

interface NotificationBellProps {
  readonly alerts: AlertsHandle;
  readonly onNotify: (message: string) => void;
}

type AlertRule = AlertState['rules'][number];

export function NotificationBell({ alerts, onNotify }: NotificationBellProps): JSX.Element {
  const { data, error, refresh } = alerts.state;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const firing = alerts.firing;
  const resolved = data ? data.events.filter((e) => e.resolvedAt !== null) : [];
  const activeCount = firing.length;
  const label = error
    ? 'Alerts unavailable'
    : activeCount > 0
      ? `${activeCount} alert${activeCount === 1 ? '' : 's'} firing`
      : 'No active alerts';

  return (
    <div className="pop-anchor" ref={wrapRef}>
      <button
        type="button"
        className={`icon-btn${activeCount > 0 || error ? ' is-alert' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <BellIcon size={15} />
        {activeCount > 0 && (
          <span className="badge-dot" aria-hidden="true">
            {activeCount > 9 ? '9+' : activeCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop" role="dialog" aria-label="Alerts">
            <div className="card-head" style={{ padding: '4px 4px 8px' }}>
              <h2 className="card-title">Alerts</h2>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  refresh();
                  onNotify('Alert state refreshed');
                }}
              >
                refresh
              </button>
            </div>

            {error && (
              <p className="banner is-error" role="status">
                <strong>Alerts unavailable.</strong> Could not read alert state ({error.message}).
              </p>
            )}

            {!error && <DesktopControl alerts={alerts} />}

            {!data && !error && <p className="empty">Loading…</p>}

            {data && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                {firing.length === 0 ? (
                  <p className="empty" style={{ padding: '14px 4px' }}>
                    Nothing firing. {data.rules.filter((r) => r.enabled).length} rules watching.
                  </p>
                ) : (
                  <ul className="alert-list">
                    {firing.map((event) => (
                      <AlertRow key={event.id} event={event} firing />
                    ))}
                  </ul>
                )}

                {resolved.length > 0 && (
                  <details>
                    <summary className="card-sub" style={{ cursor: 'pointer' }}>
                      {resolved.length} recently resolved
                    </summary>
                    <ul className="alert-list" style={{ marginTop: 8 }}>
                      {resolved.slice(0, 8).map((event) => (
                        <AlertRow key={event.id} event={event} firing={false} />
                      ))}
                    </ul>
                  </details>
                )}

                <details>
                  <summary className="card-sub" style={{ cursor: 'pointer' }}>
                    Rules ({data.rules.filter((r) => r.enabled).length}/{data.rules.length} enabled)
                  </summary>
                  <ul className="rules" style={{ marginTop: 8 }}>
                    {data.rules.map((rule) => (
                      <li key={rule.id} className={rule.enabled ? '' : 'is-off'}>
                        <span className={`state-dot ${rule.severity === 'critical' ? 'is-bad' : 'is-up'}`} aria-hidden="true" />
                        <span>
                          {rule.label}
                          <br />
                          <span className="rules-thresh">{describeThresholds(rule)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Says exactly how alerts reach you, and offers desktop notifications when possible. */
function DesktopControl({ alerts }: { readonly alerts: AlertsHandle }): JSX.Element {
  switch (alerts.desktop) {
    case 'granted':
      return (
        <p className="banner" role="status">
          Web alerts on. New alerts show here, as a toast, and as a desktop notification while this tab is open.
        </p>
      );
    case 'default':
      return (
        <div className="banner" role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>New alerts show here and as a toast while this tab is open. Desktop notifications are off.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={alerts.requestDesktop} style={{ alignSelf: 'flex-start' }}>
            Enable desktop notifications
          </button>
        </div>
      );
    case 'denied':
      return (
        <p className="banner is-warn" role="status">
          Desktop notifications are blocked in this browser. Alerts still show here and as a toast. Allow them in the
          site settings to turn them back on.
        </p>
      );
    case 'insecure':
      return (
        <p className="banner is-warn" role="status">
          New alerts show here and as a toast while this tab is open. Desktop notifications need HTTPS; this page is
          plain HTTP, so the browser does not offer them.
        </p>
      );
    default:
      return (
        <p className="banner" role="status">
          New alerts show here and as a toast while this tab is open.
        </p>
      );
  }
}

function describeThresholds(rule: AlertRule): string {
  const t = rule.thresholds;
  const parts: string[] = [];
  if (t.cpuPercent !== null) parts.push(`CPU > ${formatPercent(t.cpuPercent)}%`);
  if (t.ramPercent !== null) parts.push(`RAM > ${formatPercent(t.ramPercent)}%`);
  if (t.diskPercent !== null) parts.push(`disk > ${formatPercent(t.diskPercent)}%`);
  if (t.inodePercent !== null) parts.push(`inode > ${formatPercent(t.inodePercent)}%`);
  if (t.latencyMs.length > 0) parts.push(`latency > ${t.latencyMs[0]}ms`);
  return `${parts.length > 0 ? parts.join(' · ') : 'state only'} for ${t.forSamples} samples`;
}

function AlertRow({ event, firing }: { readonly event: AlertEvent; readonly firing: boolean }): JSX.Element {
  return (
    <li className={`alert-row is-${event.severity}${firing ? '' : ' is-resolved'}`}>
      <span className="alert-dot" aria-hidden="true" />
      <div>
        <p className="alert-msg">{event.message}</p>
        <p className="alert-meta">
          {firing
            ? `firing for ${formatAgo(Date.now() - event.since)}`
            : `held ${formatAgo(Date.now() - event.since)} · resolved ${formatAgo(Date.now() - (event.resolvedAt ?? event.since))}`}
        </p>
      </div>
    </li>
  );
}
