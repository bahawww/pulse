import { usePolled } from '../hooks/usePolled';
import { formatAgo } from '../lib/format';
import type { ReachabilityReport } from '../shared/contract';

/**
 * External reachability.
 *
 * The failure this panel prevents: every service green, port bound to 0.0.0.0,
 * and nothing outside can connect because the box is behind NAT. Local checks
 * pass in that state, so a healthy-looking dashboard proves nothing about
 * reachability. A local-only result is shown as "not verified", never "ok".
 *
 * Polled every five minutes: it cannot change quickly, and each check may make
 * an outbound request.
 */

const VERDICT: Record<ReachabilityReport['results'][number]['status'], string> = {
  ok: 'reachable from outside',
  blocked: 'not reachable from outside',
  unknown: 'not verified',
};

export function ReachabilityPanel() {
  const { data, error, loading, refresh } = usePolled<ReachabilityReport>('/api/reachability', 300_000);

  return (
    <section className="card" aria-labelledby="reach-h">
      <div className="card-head">
        <div>
          <h3 id="reach-h" className="card-title">
            Reachability
          </h3>
          <p className="card-sub">can the outside world get in</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          Check now
        </button>
      </div>

      {error && <p className="note is-error">Check failed: {error.message}</p>}
      {loading && !data && <p className="empty">Checking…</p>}

      {data && (
        <>
          <dl className="kv">
            <dt>Public IP</dt>
            <dd>{data.publicIp ?? 'unknown'}</dd>
            <dt>Tailscale</dt>
            <dd>{data.tailscaleIp ?? 'not connected'}</dd>
            <dt>Network</dt>
            <dd style={{ color: data.behindNat ? 'var(--warn)' : undefined }}>
              {data.behindNat ? 'behind NAT' : 'directly routable'}
            </dd>
          </dl>

          {data.behindNat && (
            <p className="note is-warn">
              This host is behind NAT. Ports bound to <code>0.0.0.0</code> are not reachable from the internet unless
              the router forwards them or a tunnel (cloudflared) points at them.
            </p>
          )}

          <div>
            {data.results.map((r) => (
              <div className={`reach-row is-${r.status}`} key={r.target.id}>
                <span className="state-dot" aria-hidden="true" />
                <div style={{ minWidth: 0 }}>
                  <div className="reach-label">{r.target.label}</div>
                  <div className="reach-detail" title={r.detail}>
                    {r.detail}
                  </div>
                </div>
                <span className="reach-verdict">{VERDICT[r.status]}</span>
              </div>
            ))}
          </div>

          {data.results.every((r) => r.status === 'unknown') && (
            <p className="note is-warn">
              No external checker is configured, so reachability from outside is <strong>unverified</strong>. Everything
              above was measured from this machine and would pass even with no route in from the internet.
            </p>
          )}

          {data.results.length > 0 && (
            <p className="card-foot">
              checked {formatAgo(Date.now() - Math.max(...data.results.map((r) => r.checkedAt)))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
