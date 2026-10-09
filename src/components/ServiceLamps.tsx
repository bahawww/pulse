import { type JSX } from 'react';
import { SERVICES, type StatsPayload } from '../shared/contract';
import { buildServiceUrl, type HostMode } from '../lib/urls';
import { Bone, Loading } from './Skeleton';

interface ServiceLampsProps {
  readonly data: StatsPayload | null;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
}

/** One row per service: a lamp, the name, its port and round-trip time. Click opens it. */
export function ServiceLamps({ data, hostMode, onNotify }: ServiceLampsProps): JSX.Element {
  if (!data)
    return (
      <Loading what="services">
        <ul className="lamps">
          {SERVICES.map((svc, i) => (
            <li key={svc.id} className="bone-row">
              <Bone w={10} h={10} round />
              <Bone w={`${32 + ((i * 13) % 24)}%`} />
              <Bone w={44} className="bone-end" />
            </li>
          ))}
        </ul>
      </Loading>
    );

  return (
    <ul className="lamps">
      {data.services.map((svc) => {
        const online = svc.status.online;
        return (
          <li key={svc.id}>
            <button
              type="button"
              className="lamp-row"
              onClick={() => {
                window.open(buildServiceUrl(svc, hostMode), '_blank', 'noopener,noreferrer');
                onNotify(`Opened ${svc.name}`);
              }}
            >
              <span className={`lamp lamp-sm ${online ? '' : 'is-crit'}`} aria-hidden="true" />
              <span className="lamp-name">{svc.name}</span>
              <span className="lamp-port">:{svc.port}</span>
              <span className="lamp-ms">
                {online ? (svc.status.latency !== null ? `${svc.status.latency} ms` : 'up') : 'down'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
