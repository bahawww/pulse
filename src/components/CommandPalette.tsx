import { type CSSProperties, type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { SERVICES, type StatsPayload } from '../shared/contract';
import { buildServiceUrl, copyToClipboard, isSubdomainMode, type HostMode } from '../lib/urls';
import { VIEWS, shortcutLabel } from '../lib/views';
import { CopyIcon, RefreshIcon, SearchIcon, ServiceIconGlyph, TerminalIcon, ViewIcon } from './icons';

interface PaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly data: StatsPayload | null;
  readonly hostMode: HostMode;
  readonly theme: 'dark' | 'light';
  readonly onToggleTheme: () => void;
  readonly onRefresh: () => void;
  readonly onNotify: (message: string) => void;
  readonly onOpenTerminal: () => void;
  readonly onLogout: () => void;
  /** Set only while the browser offers to install the app. */
  readonly onInstall?: () => void;
}

interface PaletteItem {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly hint: string;
  readonly color?: string;
  readonly icon: ReactNode;
  readonly keywords: string;
  readonly run: () => void;
}

const SERVICE_COLOR: Readonly<Record<string, string>> = {
  hermes: 'var(--s-mem)',
  '9router': 'var(--s-disk)',
  opencode: 'var(--s-tx)',
  novnc: 'var(--s-cpu)',
};

/**
 * Command palette (Ctrl+K or "/"). Filters services, copy-URL actions and the
 * two system actions. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette({
  open,
  onClose,
  data,
  hostMode,
  theme,
  onToggleTheme,
  onRefresh,
  onNotify,
  onOpenTerminal,
  onLogout,
  onInstall,
}: PaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const effectiveHost = hostMode === 'auto' ? window.location.hostname || '127.0.0.1' : hostMode;

  const items = useMemo<PaletteItem[]>(() => {
    const online = new Map(data?.services.map((s) => [s.id, s.status.online]) ?? []);
    const subdomains = isSubdomainMode(hostMode);

    const open: PaletteItem[] = SERVICES.map((svc) => {
      const url = buildServiceUrl(svc, hostMode);
      return {
        id: `open-${svc.id}`,
        category: 'Open',
        title: svc.name,
        description: subdomains ? url : `${svc.description.slice(0, 80)}… :${svc.port}`,
        hint: online.get(svc.id) ? 'online' : 'offline',
        color: SERVICE_COLOR[svc.id],
        icon: <ServiceIconGlyph icon={svc.icon} size={16} />,
        keywords: `${svc.name} ${svc.port} ${svc.category} open launch ${svc.id}`.toLowerCase(),
        run: () => {
          window.open(url, '_blank', 'noopener,noreferrer');
          onNotify(`Opened ${svc.name}`);
        },
      };
    });

    const copy: PaletteItem[] = SERVICES.map((svc) => {
      const url = buildServiceUrl(svc, hostMode);
      return {
        id: `copy-${svc.id}`,
        category: 'Copy URL',
        title: `Copy ${svc.name} URL`,
        description: url,
        hint: 'copy',
        color: SERVICE_COLOR[svc.id],
        icon: <CopyIcon size={15} />,
        keywords: `copy url link ${svc.name} ${svc.port}`.toLowerCase(),
        run: () => {
          void copyToClipboard(url).then((ok) => onNotify(ok ? `Copied ${svc.name} URL` : 'Copy failed. Clipboard blocked.'));
        },
      };
    });

    // Every sidebar view, with its G shortcut as the hint.
    const go: PaletteItem[] = VIEWS.map((view) => ({
      id: `go-${view.id}`,
      category: 'Go to',
      title: view.label,
      description: `Open the ${view.label.toLowerCase()} view`,
      hint: shortcutLabel(view),
      icon: <ViewIcon view={view.id} size={15} />,
      keywords: `go view page menu ${view.label} ${view.id}`,
      run: () => {
        window.location.hash = view.id;
      },
    }));

    const system: PaletteItem[] = [
      {
        id: 'theme',
        category: 'System',
        title: 'Toggle light / dark theme',
        description: `Currently ${theme}`,
        hint: 'toggle',
        icon: <SearchIcon size={15} />,
        keywords: 'toggle dark light mode theme appearance',
        run: onToggleTheme,
      },
      {
        id: 'refresh',
        category: 'System',
        title: 'Refresh telemetry now',
        description: 'Poll CPU, memory, storage and service health immediately',
        hint: 'refresh',
        icon: <RefreshIcon size={15} />,
        keywords: 'refresh reload stats ping telemetry update sync',
        run: () => {
          onRefresh();
          onNotify('Refreshing telemetry…');
        },
      },
    ];

    const session: PaletteItem[] = [
      {
        id: 'terminal',
        category: 'Terminal',
        title: 'Open terminal',
        description: 'Fullscreen shell on this host (node-pty). Windows survive reloads',
        hint: 'Ctrl `',
        icon: <TerminalIcon size={15} />,
        keywords: 'terminal shell ssh console bash tty command line',
        run: onOpenTerminal,
      },
      {
        id: 'logout',
        category: 'Account',
        title: 'Log out',
        description: 'End this session and close any open terminals',
        hint: 'sign out',
        icon: <SearchIcon size={15} />,
        keywords: 'log out logout sign out signout exit session',
        run: onLogout,
      },
    ];

    if (onInstall) {
      system.push({
        id: 'install',
        category: 'System',
        title: 'Install app',
        description: 'Add Pulse to this device as its own window',
        hint: 'install',
        icon: <CopyIcon size={15} />,
        keywords: 'install app pwa add to home screen desktop shortcut',
        run: onInstall,
      });
    }

    return [...session.slice(0, 1), ...open, ...go, ...copy, ...system, ...session.slice(1)];
  }, [data, hostMode, onInstall, onLogout, onNotify, onOpenTerminal, onRefresh, onToggleTheme, theme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((item) => item.keywords.includes(q)) : items;
  }, [items, query]);

  // Reset on open, focus the input once the overlay is mounted.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  // A new query starts from the top of the list.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length) setActive((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length) setActive((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[active];
        if (item) {
          onClose();
          item.run();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, filtered, active, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let lastCategory = '';

  return (
    <div className="palette-root" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette-backdrop" onMouseDown={onClose} />
      <div className="palette">
        <div className="palette-input-row">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Search services, terminal and actions"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search commands"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <p className="palette-empty">No match for “{query}”. Try “hermes”, “copy” or “dark”.</p>
          ) : (
            filtered.map((item, index) => {
              const showCategory = item.category !== lastCategory;
              lastCategory = item.category;
              return (
                <div key={item.id}>
                  {showCategory && <div className="palette-cat">{item.category}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`palette-item${index === active ? ' is-active' : ''}`}
                    style={item.color ? ({ '--svc': item.color } as CSSProperties) : undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      onClose();
                      item.run();
                    }}
                  >
                    <span className="palette-item-glyph" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="palette-item-text">
                      <span className="palette-item-title">{item.title}</span>
                      <span className="palette-item-desc">{item.description}</span>
                    </span>
                    <span className="palette-item-hint">{item.hint}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span className="palette-foot-host">host {effectiveHost}</span>
        </div>
      </div>
    </div>
  );
}

/** Short-lived status message. Remount it with a new `key` to show the same text again. */
export function Toast({ message }: { readonly message: string }): JSX.Element | null {
  // 'out' keeps the toast mounted for its exit animation (.toast.is-out).
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>(message ? 'in' : 'gone');

  useEffect(() => {
    if (!message) return undefined;
    setPhase('in');
    const out = setTimeout(() => setPhase('out'), 2200);
    const gone = setTimeout(() => setPhase('gone'), 2200 + TOAST_EXIT_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, [message]);

  if (phase === 'gone' || !message) return null;

  return (
    <div className={`toast${phase === 'out' ? ' is-out' : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

/** Matches the toast-out animation in motion.css. */
const TOAST_EXIT_MS = 260;
