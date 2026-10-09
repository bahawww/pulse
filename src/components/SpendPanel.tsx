import type { ReactNode } from 'react';
import { usePolled } from '../hooks/usePolled';
import { formatTokens, formatUsd } from '../lib/format';
import type { SpendPoint, SpendReport } from '../shared/contract';
import { Bone, Loading } from './Skeleton';

/**
 * LLM spend through 9router.
 *
 * An unavailable source renders as an explanation, never as $0.00. "Spent
 * nothing" and "could not check" are different facts, and only one is good
 * news. Costs show six decimals below a cent, because per-request spend is
 * fractions of a penny and would otherwise read as a broken $0.00.
 */

export function SpendPanel() {
  const { data, error } = usePolled<SpendReport>('/api/spend', 60_000);

  const frame = (body: ReactNode, badge?: ReactNode) => (
    <section className="card" aria-labelledby="spend-h">
      <div className="card-head">
        <div>
          <h3 id="spend-h" className="card-title">
            LLM spend
          </h3>
          <p className="card-sub">9router usage and cost</p>
        </div>
        {badge}
      </div>
      {body}
    </section>
  );

  if (error) return frame(<p className="note is-error">Could not read spend data: {error.message}</p>);
  if (!data)
    return frame(
      <Loading what="spend">
        <div className="bone-row" style={{ borderTop: 0, gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <Bone key={i} h={52} style={{ flex: 1 }} />
          ))}
        </div>
        <Bone h={120} className="bone-chart" />
      </Loading>,
    );

  if (!data.available) {
    return frame(
      <>
        <p className="note is-warn">{data.reason}</p>
        <p className="card-foot">
          Source <code>{data.source}</code>. This is a reporting gap, not a zero. Spend may well be happening.
        </p>
      </>,
      <span className="pill is-off">unavailable</span>,
    );
  }

  const peak = data.daily.reduce<SpendPoint | null>((best, d) => (best === null || d.costUsd > best.costUsd ? d : best), null);
  const maxDaily = Math.max(0, ...data.daily.map((d) => d.costUsd));
  const recent = data.daily.slice(-14);

  return frame(
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Today</span>
          <span className="stat-value">{formatUsd(data.todayCostUsd)}</span>
          <span className="stat-sub">{data.todayRequests} requests</span>
        </div>
        <div className="stat">
          <span className="stat-label">All time</span>
          <span className="stat-value">{formatUsd(data.totalCostUsd)}</span>
          <span className="stat-sub">{formatTokens(data.totalTokens)} tokens</span>
        </div>
        <div className="stat">
          <span className="stat-label">Per request</span>
          <span className="stat-value">{formatUsd(data.avgCostPerRequest)}</span>
          <span className="stat-sub">{data.totalRequests.toLocaleString()} requests</span>
        </div>
      </div>

      {recent.length > 0 && (
        <div>
          <p className="card-sub" style={{ marginBottom: 8 }}>
            Daily cost, last {recent.length} days
          </p>
          <div className="spend-bars" role="img" aria-label="Daily cost, oldest to newest">
            {recent.map((d) => {
              const height = maxDaily > 0 ? Math.max(3, (d.costUsd / maxDaily) * 100) : 3;
              return (
                <div className="spend-bar-col" key={d.t}>
                  <span
                    className="spend-bar"
                    style={{ height: `${height}%` }}
                    title={`${new Date(d.t).toISOString().slice(0, 10)}: ${formatUsd(d.costUsd)} · ${d.requests} req`}
                  />
                </div>
              );
            })}
          </div>
          {peak && (
            <p className="card-foot" style={{ marginTop: 8 }}>
              peak {formatUsd(peak.costUsd)} on {new Date(peak.t).toISOString().slice(0, 10)}
            </p>
          )}
        </div>
      )}

      {data.byModel.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Requests
              </th>
              <th scope="col" className="num">
                Tokens
              </th>
              <th scope="col" className="num">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.slice(0, 6).map((m) => (
              <tr key={`${m.model}-${m.provider}`}>
                <td className="truncate" title={`${m.model} via ${m.provider}`}>
                  {m.model}
                </td>
                <td className="num">{m.requests.toLocaleString()}</td>
                <td className="num">{formatTokens(m.tokens)}</td>
                <td className="num">{formatUsd(m.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
}
