import { type CSSProperties, type JSX, useLayoutEffect, useRef, useState } from 'react';
import { categoryFilters, type Service, type ServiceMeta, type StatsPayload } from '../shared/contract';
import { buildServiceUrl, copyToClipboard, usesSubdomain, type HostMode } from '../lib/urls';
import { subdomainFor } from '../lib/site';
import { postJson } from '../lib/csrf';
import { transition } from '../lib/motion';
import { Bone, BoneLines, Loading } from './Skeleton';
import { MoreMenu } from './MoreMenu';
import { ArrowUpRightIcon, CopyIcon, EyeIcon, EyeOffIcon, LinkIcon, RefreshIcon, ServiceIconGlyph } from './icons';

interface ServicesGridProps {
  readonly data: StatsPayload | null;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
  /** Re-fetch the stats after a hide or a scan changed the list. */
  readonly onRefresh: () => void;
  /** Hide, show and rescan need the services:control permission. */
  readonly canEdit: boolean;
}

/** Cards drawn while the first stats are on their way. */
const SKELETON_CARDS = 4;

/**
 * Application launcher: category tabs, one card per service, live status from
 * the probe. Curated services plus whatever the server's auto scan found
 * (src/server/discover.ts); any card can be hidden and shown again. Number
 * keys 1-9 open a service; see App for the key handling.
 */
export function ServicesGrid({ data, hostMode, onNotify, onRefresh, canEdit }: ServicesGridProps): JSX.Element {
  const all = data?.services ?? [];
  const hidden = data?.hiddenServices ?? [];
  const filters = categoryFilters(all);
  const [chosen, setCategory] = useState('all');
  // A category whose last card was hidden falls back to all.
  const category = filters.some((f) => f.id === chosen) ? chosen : 'all';
  const visible = category === 'all' ? all : all.filter((s) => s.category === category);
  const [showHidden, setShowHidden] = useState(false);
  const [scanning, setScanning] = useState(false);

  const setHidden = async (service: ServiceMeta, hide: boolean) => {
    const res = await postJson('/api/services/hidden', { id: service.id, hidden: hide }).catch(() => null);
    if (!res?.ok) {
      onNotify(`Could not ${hide ? 'hide' : 'show'} ${service.name}`);
      return;
    }
    onNotify(hide ? `Hid ${service.name}` : `${service.name} is back`);
    transition('filter', onRefresh);
  };

  const scan = async () => {
    setScanning(true);
    const res = await postJson('/api/services/scan').catch(() => null);
    setScanning(false);
    if (!res?.ok) {
      onNotify('Scan failed');
      return;
    }
    const found = (await res.json().catch(() => ({}))) as { visible?: number };
    onNotify(`Scan done: ${found.visible ?? '?'} services`);
    transition('filter', onRefresh);
  };

  // The highlight behind the active tab, measured from the DOM so it can spring
  // from tab to tab (motion.css) instead of each tab lighting up on its own.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const tab = tabsRef.current?.querySelector<HTMLElement>('.tab.is-active');
      setPill(tab ? { x: tab.offsetLeft, y: tab.offsetTop, w: tab.offsetWidth, h: tab.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (tabsRef.current) observer.observe(tabsRef.current);
    return () => observer.disconnect();
  }, [category]);

  /** Switch category inside a View Transition: cards that stay glide to their
   * new place, the rest blur out and in (motion.css, kind "filter"). */
  const choose = (id: string) => {
    if (id === category) return;
    transition('filter', () => setCategory(id));
  };

  return (
    <div className="section-body">
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <div className="tabs" role="tablist" aria-label="Filter services by category" ref={tabsRef}>
          {pill && (
            <span
              className="tab-pill"
              style={{ width: pill.w, height: pill.h, transform: `translate(${pill.x}px, ${pill.y}px)` }}
              aria-hidden="true"
            />
          )}
          {filters.map((filter) => {
            const count = filter.id === 'all' ? all.length : all.filter((s) => s.category === filter.id).length;
            return (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={category === filter.id}
                className={`tab${category === filter.id ? ' is-active' : ''}`}
                onClick={() => choose(filter.id)}
              >
                {filter.label}
                <span className="tab-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="tw:flex tw:items-center tw:gap-2">
          {canEdit && hidden.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            >
              <EyeOffIcon size={13} />
              Hidden {hidden.length}
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void scan()} disabled={scanning} title="Look for new apps now">
              <RefreshIcon size={13} />
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          )}
        </div>
      </div>

      {canEdit && showHidden && hidden.length > 0 && (
        <ul className="tw:mb-4 tw:flex tw:flex-wrap tw:gap-2" aria-label="Hidden services">
          {hidden.map((s) => (
            <li
              key={s.id}
              className="tw:flex tw:items-center tw:gap-2 tw:rounded-md tw:border tw:border-line tw:bg-surface tw:py-1 tw:pr-1 tw:pl-3 tw:text-[13px] tw:text-fg-2"
            >
              <span className="tw:max-w-48 tw:truncate">{s.name}</span>
              <span className="tw:font-mono tw:text-[11px] tw:text-fg-3">:{s.port}</span>
              <button type="button" className="btn btn-icon btn-sm" onClick={() => void setHidden(s, false)} aria-label={`Show ${s.name}`} title="Show again">
                <EyeIcon size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!data ? (
        <Loading what="services">
          <div className="svc-grid">
            {Array.from({ length: SKELETON_CARDS }, (_, i) => (
              <div key={i} className="svc skeleton-card" aria-hidden="true">
                <div className="bone-row" style={{ padding: 0 }}>
                  <Bone w={36} h={36} />
                  <div className="skeleton-head" style={{ flex: 1 }}>
                    <Bone w="50%" h={14} />
                    <Bone w="30%" h={10} />
                  </div>
                </div>
                <BoneLines count={2} />
                <div className="bone-row" style={{ padding: 0, borderTop: 0 }}>
                  <Bone w={90} h={28} />
                  <Bone w={28} h={28} className="bone-end" />
                </div>
              </div>
            ))}
          </div>
        </Loading>
      ) : visible.length === 0 ? (
        <p className="empty">No services in this category.</p>
      ) : (
        <div className="svc-grid">
          {visible.map((service, index) => (
            <ServiceCard
              // Keyed by service alone: a card that stays in the new category is
              // the same element, so the transition can move it rather than redraw it.
              key={service.id}
              service={service}
              index={index}
              hostMode={hostMode}
              onNotify={onNotify}
              onHide={canEdit ? () => void setHidden(service, true) : undefined}
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
  onHide,
}: {
  readonly service: Service;
  readonly index: number;
  readonly hostMode: HostMode;
  readonly onNotify: (message: string) => void;
  readonly onHide?: () => void;
}): JSX.Element {
  const url = buildServiceUrl(service, hostMode);
  const subdomain = usesSubdomain(service, hostMode);
  const { online, latency } = service.status;

  const copy = async () => {
    const ok = await copyToClipboard(url);
    onNotify(ok ? `Copied ${service.name} URL` : 'Copy failed. Clipboard blocked.');
  };

  return (
    <article
      className="svc"
      style={{ '--i': index, '--vt-name': `svc-${service.id}` } as CSSProperties}
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
        {service.keyNumber && <span className="tag">key {service.keyNumber}</span>}
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
        <button type="button" className="btn btn-icon svc-full" onClick={() => void copy()} aria-label={`Copy ${service.name} URL`} title="Copy URL">
          <CopyIcon size={14} />
        </button>
        {onHide && (
          <button type="button" className="btn btn-icon svc-full" onClick={onHide} aria-label={`Hide ${service.name}`} title="Hide">
            <EyeOffIcon size={14} />
          </button>
        )}
        {/* A phone keeps Open and tucks the rest away. */}
        <span className="svc-compact">
          <MoreMenu
            label={`More for ${service.name}`}
            items={[{ label: 'Copy URL', onSelect: () => void copy() }, ...(onHide ? [{ label: 'Hide this card', onSelect: onHide }] : [])]}
          />
        </span>
      </div>
    </article>
  );
}
