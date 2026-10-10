import { type CSSProperties, type JSX } from 'react';
import { SERVICES, type Service, type StatsPayload } from '../shared/contract';
import { buildServiceUrl, type HostMode } from '../lib/urls';
import { serviceColor } from '../lib/serviceColor';
import { Bone, Loading } from './Skeleton';
import { ServiceIconGlyph } from './icons';

interface ServiceLampsProps {
  readonly data: StatsPayload | null;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return Math.round(value * 10) / 10;
}

/** One line that says whether anything needs attention, before any tile is read. */
function summaryText(services: readonly Service[]): { readonly text: string; readonly allUp: boolean } {
  const down = services.filter((s) => !s.status.online);
  if (down.length === 0) {
    return { text: services.length === 1 ? '1 service online' : `All ${services.length} services online`, allUp: true };
  }
  const names = down.map((s) => s.name).join(', ');
  return { text: `${down.length} of ${services.length} down: ${names}`, allUp: false };
}

/** A tile per service: icon, status and latency on top, name and port below. Click opens it. */
export function ServiceLamps({ data, hostMode, onNotify }: ServiceLampsProps): JSX.Element {
  if (!data)
    return (
      <Loading what="services">
        <ul className="lamps">
          {SERVICES.map((svc, i) => (
            <li key={svc.id} className="bone-row">
              <Bone w={32} h={32} />
              <Bone w={`${48 + ((i * 13) % 30)}%`} />
              <Bone w={44} />
            </li>
          ))}
        </ul>
      </Loading>
    );

  const summary = summaryText(data.services);
  const latencies = data.services.flatMap((s) => (s.status.online && s.status.latency !== null ? [s.status.latency] : []));
  const mid = median(latencies);

  return (
    <ul className="lamps">
      <li className="lamps-summary">
        <span className={`lamp lamp-sm ${summary.allUp ? '' : 'is-crit'}`} aria-hidden="true" />
        <span className="lamps-summary-text">{summary.text}</span>
        {mid !== null && <span className="lamps-summary-ms">median {mid} ms</span>}
      </li>
      {data.services.map((svc) => {
        const online = svc.status.online;
        const latency = svc.status.latency;
        return (
          <li key={svc.id}>
            <button
              type="button"
              className={`lamp-row ${online ? '' : 'is-down'}`}
              style={{ '--c': serviceColor(svc.id) } as CSSProperties}
              onClick={() => {
                window.open(buildServiceUrl(svc, hostMode), '_blank', 'noopener,noreferrer');
                onNotify(`Opened ${svc.name}`);
              }}
            >
              <span className="lamp-top">
                <span className="lamp-chip" aria-hidden="true">
                  <ServiceIconGlyph icon={svc.icon} size={18} />
                </span>
                <span className="lamp-state">
                  <span className="lamp-ms">{online ? (latency !== null ? `${latency} ms` : 'up') : 'down'}</span>
                  <span className={`lamp lamp-sm ${online ? '' : 'is-crit'}`} aria-hidden="true" />
                </span>
              </span>
              <span className="lamp-name">{svc.name}</span>
              <span className="lamp-port">:{svc.port}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
