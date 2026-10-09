import { type JSX, useEffect, useRef, useState } from 'react';
import { type AlertsHandle } from '../hooks/useAlerts';
import { type AuthUser } from '../hooks/useAuth';
import { type Theme, type ThemeOrigin } from '../hooks/useTheme';
import { HOST_OPTIONS, type HostMode } from '../lib/urls';
import { VIEW_GROUPS, VIEWS, type ViewId } from '../lib/views';
import { CheckIcon, MoonIcon, SearchIcon, SunIcon } from './icons';
import { NotificationBell } from './NotificationBell';

interface NavbarProps {
  readonly theme: Theme;
  readonly onToggleTheme: (origin?: ThemeOrigin) => void;
  readonly onOpenPalette: () => void;
  readonly hostMode: HostMode;
  readonly onHostModeChange: (mode: HostMode) => void;
  /** Toast sink for the alerts popover's own refresh action. */
  readonly onNotify: (message: string) => void;
  readonly alerts: AlertsHandle;
  readonly user: AuthUser;
  readonly onLogout: () => void;
  /** The current view, named on the left of the bar on desktop (where the brand is in the sidebar). */
  readonly active: ViewId;
}

/**
 * Top bar. Global controls only: search, the target-host override for service
 * links, alerts, and theme. Below 1024px, where the sidebar is hidden, it also
 * gets a view menu.
 */
export function Navbar({
  theme,
  onToggleTheme,
  onOpenPalette,
  hostMode,
  onHostModeChange,
  onNotify,
  alerts,
  user,
  onLogout,
  active,
}: NavbarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setNavOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !navRef.current?.contains(e.target)) setNavOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [navOpen]);

  const current = HOST_OPTIONS.find((o) => o.value === hostMode);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a href="/" className="brand" aria-label="Pulse home">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">Pulse</span>
          </span>
        </a>

        {(() => {
          const group = VIEW_GROUPS.find((g) => g.items.some((i) => i.id === active));
          const item = group?.items.find((i) => i.id === active);
          if (!group || !item) return null;
          return (
            <p className="topbar-title" aria-hidden="true">
              {group.title !== item.label && <span className="topbar-crumb">{group.title}</span>}
              <span className="topbar-page">{item.label}</span>
            </p>
          );
        })()}

        <div className="topbar-actions">
          <button
            type="button"
            className="search-btn"
            onClick={onOpenPalette}
            title="Search services and actions (Ctrl+K)"
            aria-label="Search services and actions"
          >
            <SearchIcon size={15} />
            <span className="grow">Search services and actions</span>
            <kbd className="kbd-long">Ctrl K</kbd>
          </button>

          <div className="pop-anchor link-target" ref={menuRef}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-label={`Link target: ${current?.label ?? hostMode}`}
              title={`Link target: ${current?.label ?? hostMode}`}
            >
              <GlobeGlyph />
            </button>
            {menuOpen && (
              <>
                <div className="pop-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />
                <div className="pop" role="listbox" aria-label="Link target">
                  <p className="card-sub" style={{ padding: '6px 10px 8px' }}>
                    Where service links point. Direct ports only work inside the LAN or over Tailscale.
                  </p>
                  {HOST_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={hostMode === opt.value}
                      className={`menu-item${hostMode === opt.value ? ' is-selected' : ''}`}
                      onClick={() => {
                        setMenuOpen(false);
                        onHostModeChange(opt.value);
                      }}
                    >
                      <CheckIcon className="menu-check" size={14} />
                      <span className="menu-item-text">
                        <span className="menu-item-label">{opt.label}</span>
                        <span className="menu-item-hint">{opt.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <NotificationBell alerts={alerts} onNotify={onNotify} />

          <button
            type="button"
            className="icon-btn theme-btn"
            onClick={(e) => {
              // The new theme grows out of the button's centre.
              const r = e.currentTarget.getBoundingClientRect();
              onToggleTheme({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
            title="Toggle light and dark theme"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {/* Keyed so each switch remounts the glyph and replays its spin-in. */}
            <span key={theme} className="theme-glyph">
              {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </span>
          </button>

          <button
            type="button"
            className="icon-btn"
            onClick={onLogout}
            title={`Signed in as ${user.name}. Click to log out.`}
            aria-label={`Log out ${user.name}`}
          >
            <LogoutGlyph />
          </button>

          {/* Last on purpose: on phones this is the top-right corner. */}
          <div className="pop-anchor nav-toggle" ref={navRef}>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setNavOpen((open) => !open)}
              aria-controls="section-nav"
              aria-expanded={navOpen}
              aria-label={navOpen ? 'Close section menu' : 'Open section menu'}
            >
              {navOpen ? <CloseGlyph /> : <MenuGlyph />}
            </button>
            {navOpen && (
              <>
                <div className="pop-backdrop" aria-hidden="true" onClick={() => setNavOpen(false)} />
                <nav id="section-nav" className="pop nav-pop" aria-label="Views">
                  {VIEWS.map((view) => (
                    <a
                      key={view.id}
                      href={`#${view.id}`}
                      className="menu-item"
                      onClick={() => setNavOpen(false)}
                    >
                      <span className="menu-item-label">{view.label}</span>
                    </a>
                  ))}
                </nav>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Logo: flat 2D. A blue rounded square with one white heartbeat line, the
 * pulse of a live server. Two flat colours, no effects.
 */
export function BrandMark(): JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="var(--logo-bg)" />
      <path
        d="M6 22h9l4-12 6 20 4-8h8"
        fill="none"
        stroke="var(--logo-fg)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function LogoutGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function GlobeGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
