import { type CSSProperties, type JSX, useState } from 'react';
import { CATEGORY_FILTERS, SERVICES, type CategoryFilter, type Service, type StatsPayload } from '../shared/contract';
import { buildServiceUrl, copyToClipboard, isSubdomainMode, type HostMode } from '../lib/urls';
import { subdomainFor } from '../lib/site';
import { ArrowUpRightIcon, CopyIcon, LinkIcon, ServiceIconGlyph } from './icons';

/** Each service keeps one categorical colour for its whole life on the page. */
const SERVICE_COLOR: Readonly<Record<string, string>> = {
  hermes: 'var(--s-mem)',
  '9router': 'var(--s-disk)',
  opencode: 'var(--s-tx)',
  novnc: 'var(--s-cpu)',
};

interface ServicesGridProps {
  readonly data: StatsPayload | null;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
}

/**
 * Application launcher: category tabs, one card per service, live status from
 * the probe. Number keys 1-4 open a service; see App for the key handling.
 */
export function ServicesGrid({ data, hostMode, onNotify }: ServicesGridProps): JSX.Element {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const all = data?.services ?? [];
  const visible = category === 'all' ? all : all.filter((s) => s.category === category);

  return (
    <div className="section-body">
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <div className="tabs" role="tablist" aria-label="Filter services by category">
          {CATEGORY_FILTERS.map((filter) => {
            const count =
              filter.id === 'all' ? SERVICES.length : SERVICES.filter((s) => s.category === filter.id).length;
            return (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={category === filter.id}
                className={`tab${category === filter.id ? ' is-active' : ''}`}
                onClick={() => setCategory(filter.id)}
              >
                {filter.label}
                <span className="tab-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="empty">No services in this category.</p>
      ) : (
        <div className="svc-grid">
          {visible.map((service, index) => (
            <ServiceCard
              key={`${category}:${service.id}`}
              service={service}
              index={index}
              hostMode={hostMode}
              onNotify={onNotify}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceCard({
  service,
  index,
  hostMode,
  onNotify,
}: {
  readonly service: Service;
  readonly index: number;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
}): JSX.Element {
  const url = buildServiceUrl(service, hostMode);
  const subdomain = isSubdomainMode(hostMode);
  const { online, latency } = service.status;
  const color = SERVICE_COLOR[service.id] ?? 'var(--accent)';

  const copy = async () => {
    const ok = await copyToClipboard(url);
    onNotify(ok ? `Copied ${service.name} URL` : 'Copy failed. Clipboard blocked.');
  };

  return (
    <article
      className="svc"
      style={{ '--i': index, '--svc': color } as CSSProperties}
      data-service-id={service.id}
    >
      <div className="svc-head">
        <div className="svc-id">
          <span className="svc-glyph" aria-hidden="true">
            <ServiceIconGlyph icon={service.icon} size={22} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 className="svc-name">{service.name}</h3>
            <span className="svc-cat">{service.category}</span>
          </div>
        </div>
      </div>

      <div className="svc-status">
        {online ? (
          <span className="pill is-ok">{latency != null ? `Online · ${latency}ms` : 'Online'}</span>
        ) : (
          <span className="pill is-crit">Offline</span>
        )}
        <span className="tag">key {service.keyNumber}</span>
      </div>

      <p className="svc-desc">{service.description}</p>

      <div className="svc-addr" title={url}>
        <LinkIcon size={12} />
        <span>{subdomain ? (subdomainFor(service.id) ?? url) : `:${service.port}${service.path}`}</span>
      </div>

      <div className="svc-actions">
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
          Open
          <ArrowUpRightIcon size={13} />
        </a>
        <button type="button" className="btn btn-icon" onClick={() => void copy()} aria-label={`Copy ${service.name} URL`} title="Copy URL">
          <CopyIcon size={14} />
        </button>
      </div>
    </article>
  );
}
