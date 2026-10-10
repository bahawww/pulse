import { type JSX, type ReactNode, type SVGProps, useEffect, useRef, useState } from 'react';
import { SCHEMES, SITE_SCHEME } from '../../lib/termThemes';
import { newId, resolveScheme, SCROLLBACK_CHOICES, SHORTCUTS, type ModState, type Prefs, type Snippet } from './model';

// ------------------------------------------------------------------ icons (terminal-only, same stroke style as icons.tsx)

const svg = (size: number): SVGProps<SVGSVGElement> => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  width: size,
  height: size,
  'aria-hidden': true,
});

type IconFn = (p: { readonly size?: number }) => JSX.Element;

export const Icon = {
  search: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  bolt: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  tile: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M3 12h9" />
    </svg>
  ),
  tabs: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18M8 6V4h6v2" />
    </svg>
  ),
  palette: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4z" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1" fill="currentColor" />
      <circle cx="15" cy="8" r="1" fill="currentColor" />
    </svg>
  ),
  more: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </svg>
  ),
  expand: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  ),
  shrink: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </svg>
  ),
  down: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  plus: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  keyboard: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  ),
  broadcast: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />
    </svg>
  ),
  download: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  ),
  copy: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  ),
  eraser: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="m7 21-4-4 10-10 8 8-6 6zM21 21H7M9 11l6 6" />
    </svg>
  ),
  restart: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  ),
  text: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M4 7V5h16v2M9 19h6M12 5v14" />
    </svg>
  ),
  play: ({ size = 14 }) => (
    <svg {...svg(size)}>
      <path d="m7 4 12 8-12 8z" />
    </svg>
  ),
  edit: ({ size = 14 }) => (
    <svg {...svg(size)}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  ),
  trash: ({ size = 14 }) => (
    <svg {...svg(size)}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  ),
  splitRight: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  ),
  splitDown: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18" />
    </svg>
  ),
  zoom: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="7" y="8" width="10" height="8" rx="1" />
    </svg>
  ),
  plug: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" />
    </svg>
  ),
  router: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 17h.01M10 17h.01M15 9a4 4 0 0 0-6 0M18 6a8 8 0 0 0-12 0M12 13v-1" />
    </svg>
  ),
  command: ({ size = 16 }) => (
    <svg {...svg(size)}>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </svg>
  ),
  close: ({ size = 14 }) => (
    <svg {...svg(size)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
} satisfies Record<string, IconFn>;

// ------------------------------------------------------------------ popover shell

/** Closes on a click outside itself or on its toggle button (`.tw-pop-toggle[data-pop=id]`). */
export function Popover({
  id,
  label,
  onClose,
  className = '',
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly onClose: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest?.(`[data-pop="${id}"]`)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [id, onClose]);
  return (
    <div ref={ref} className={`tw-pop ${className}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ appearance and behaviour

interface ThemePanelProps {
  readonly prefs: Prefs;
  readonly siteTheme: 'dark' | 'light';
  readonly onChange: (p: Partial<Prefs>) => void;
  readonly onClose: () => void;
}

function Toggle({ on, label, hint, onChange }: { readonly on: boolean; readonly label: string; readonly hint?: string; readonly onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="tw-toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.currentTarget.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

export function ThemePanel({ prefs, siteTheme, onChange, onClose }: ThemePanelProps): JSX.Element {
  const all = [resolveScheme(SITE_SCHEME, siteTheme), ...SCHEMES];
  return (
    <Popover id="theme" label="Terminal appearance and behaviour" onClose={onClose} className="tw-pop-theme">
      <div className="tw-pop-head">Colour scheme</div>
      <div className="tw-schemes">
        {all.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`tw-scheme${prefs.scheme === s.id ? ' is-on' : ''}`}
            aria-pressed={prefs.scheme === s.id}
            onClick={() => onChange({ scheme: s.id })}
            style={{ background: s.background, color: s.foreground }}
          >
            <span className="tw-scheme-prompt">
              <span style={{ color: s.ansi[2] }}>❯</span> <span style={{ color: s.ansi[4] }}>~/src</span> <span style={{ color: s.ansi[3] }}>git</span>
              <span className="tw-scheme-caret" style={{ background: s.cursor }} />
            </span>
            <span className="tw-scheme-dots" aria-hidden="true">
              {s.ansi.slice(1, 7).map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
            <span className="tw-scheme-name">{s.id === SITE_SCHEME ? 'Dashboard (auto)' : s.name}</span>
          </button>
        ))}
      </div>

      <div className="tw-pop-head">Cursor</div>
      <div className="tw-seg" role="group" aria-label="Cursor style">
        {(['bar', 'block', 'underline'] as const).map((c) => (
          <button key={c} type="button" className={`tw-chip${prefs.cursorStyle === c ? ' is-on' : ''}`} aria-pressed={prefs.cursorStyle === c} onClick={() => onChange({ cursorStyle: c })}>
            {c === 'bar' ? '▏ Bar' : c === 'block' ? '█ Block' : '▁ Underline'}
          </button>
        ))}
      </div>

      <div className="tw-pop-head">Text</div>
      <div className="tw-seg" role="group" aria-label="Text weight">
        <button type="button" className={`tw-chip${prefs.weight === 400 ? ' is-on' : ''}`} aria-pressed={prefs.weight === 400} onClick={() => onChange({ weight: 400 })}>
          Regular
        </button>
        <button type="button" className={`tw-chip${prefs.weight === 500 ? ' is-on' : ''}`} aria-pressed={prefs.weight === 500} onClick={() => onChange({ weight: 500 })}>
          Medium
        </button>
      </div>
      <label className="tw-range">
        <span>Line height</span>
        <input type="range" min={1} max={1.8} step={0.05} value={prefs.lineHeight} onChange={(e) => onChange({ lineHeight: Number(e.currentTarget.value) })} />
        <output>{prefs.lineHeight.toFixed(2)}</output>
      </label>

      <div className="tw-pop-head">History</div>
      <div className="tw-seg" role="group" aria-label="Scrollback lines">
        {SCROLLBACK_CHOICES.map((n) => (
          <button key={n} type="button" className={`tw-chip${prefs.scrollback === n ? ' is-on' : ''}`} aria-pressed={prefs.scrollback === n} onClick={() => onChange({ scrollback: n })}>
            {n >= 1000 ? `${n / 1000}k` : n} lines
          </button>
        ))}
      </div>

      <div className="tw-pop-head">Behaviour</div>
      <div className="tw-toggles">
        <Toggle on={prefs.blink} label="Blinking cursor" onChange={(v) => onChange({ blink: v })} />
        <Toggle on={prefs.copyOnSelect} label="Copy on select" hint="Selected text goes to the clipboard" onChange={(v) => onChange({ copyOnSelect: v })} />
        <Toggle on={prefs.confirmPaste} label="Confirm multi-line paste" hint="Each line would run as a command" onChange={(v) => onChange({ confirmPaste: v })} />
        <Toggle on={prefs.boldBright} label="Bold in bright colours" hint="Like classic xterm" onChange={(v) => onChange({ boldBright: v })} />
      </div>
    </Popover>
  );
}

// ------------------------------------------------------------------ snippets

interface SnippetsProps {
  readonly list: readonly Snippet[];
  readonly onChange: (list: readonly Snippet[]) => void;
  /** Run: send the command and Enter. Insert: type it without running. */
  readonly onUse: (command: string, run: boolean) => void;
  readonly onClose: () => void;
}

export function SnippetsPanel({ list, onChange, onUse, onClose }: SnippetsProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((s) => s.label.toLowerCase().includes(q) || s.command.toLowerCase().includes(q)) : list;
  const at = Math.min(cursor, Math.max(0, shown.length - 1));

  const save = (s: Snippet) => {
    const clean = { ...s, label: s.label.trim(), command: s.command.trim() };
    if (!clean.command) return;
    const exists = list.some((x) => x.id === s.id);
    onChange(exists ? list.map((x) => (x.id === s.id ? clean : x)) : [...list, clean]);
    setEditing(null);
  };

  if (editing) {
    return (
      <Popover id="snippets" label="Edit snippet" onClose={onClose} className="tw-pop-snip">
        <form
          className="tw-snip-form"
          onSubmit={(e) => {
            e.preventDefault();
            save(editing);
          }}
        >
          <div className="tw-pop-head">{list.some((x) => x.id === editing.id) ? 'Edit snippet' : 'New snippet'}</div>
          <label>
            <span>Name</span>
            <input value={editing.label} placeholder="Restart nginx" onChange={(e) => setEditing({ ...editing, label: e.currentTarget.value })} autoFocus />
          </label>
          <label>
            <span>Command</span>
            <textarea
              value={editing.command}
              rows={3}
              spellCheck={false}
              placeholder="sudo systemctl restart nginx"
              onChange={(e) => setEditing({ ...editing, command: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  save(editing);
                }
              }}
            />
          </label>
          <div className="tw-snip-actions">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!editing.command.trim()}>
              Save
            </button>
          </div>
        </form>
      </Popover>
    );
  }

  return (
    <Popover id="snippets" label="Snippets" onClose={onClose} className="tw-pop-snip">
      <div className="tw-snip-top">
        <input
          ref={input}
          className="tw-snip-search"
          placeholder="Search snippets"
          aria-label="Search snippets"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(shown.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const s = shown[at];
              if (s) onUse(s.command, !e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <button type="button" className="tw-icon-btn" aria-label="New snippet" title="New snippet" onClick={() => setEditing({ id: newId(), label: '', command: '' })}>
          <Icon.plus />
        </button>
      </div>
      <ul className="tw-snips" role="listbox" aria-label="Snippets">
        {shown.map((s, i) => (
          <li key={s.id} role="option" aria-selected={i === at} className={i === at ? 'is-at' : ''} onMouseEnter={() => setCursor(i)}>
            <button type="button" className="tw-snip-main" onClick={() => onUse(s.command, true)} title="Run (Enter)">
              <span className="tw-snip-label">{s.label || s.command}</span>
              <code>{s.command}</code>
            </button>
            <span className="tw-snip-tools">
              <button type="button" className="tw-icon-btn is-sm" aria-label={`Insert ${s.label || s.command} without running`} title="Insert without running (Shift+Enter)" onClick={() => onUse(s.command, false)}>
                <Icon.text size={14} />
              </button>
              <button type="button" className="tw-icon-btn is-sm" aria-label={`Edit ${s.label || s.command}`} title="Edit" onClick={() => setEditing(s)}>
                <Icon.edit />
              </button>
              <button type="button" className="tw-icon-btn is-sm" aria-label={`Delete ${s.label || s.command}`} title="Delete" onClick={() => onChange(list.filter((x) => x.id !== s.id))}>
                <Icon.trash />
              </button>
            </span>
          </li>
        ))}
        {shown.length === 0 && <li className="tw-snip-empty">{list.length ? 'No snippet matches.' : 'No snippets yet. Add one with +.'}</li>}
      </ul>
      <p className="tw-pop-foot">
        <kbd>Enter</kbd> run · <kbd>Shift+Enter</kbd> insert · <kbd>↑↓</kbd> choose
      </p>
    </Popover>
  );
}

// ------------------------------------------------------------------ shortcut sheet

export function ShortcutSheet({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <div className="tw-sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tw-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header>
          <h2>Keyboard shortcuts</h2>
          <button ref={close} type="button" className="tw-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon.close size={16} />
          </button>
        </header>
        <div className="tw-sheet-grid">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              <dl>
                {g.items.map((s) => (
                  <div key={s.keys}>
                    <dt>
                      <kbd>{s.keys}</kbd>
                    </dt>
                    <dd>{s.does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ key bar button

interface KeyButtonProps {
  readonly label: string;
  /** Spoken name when the label is a symbol. */
  readonly name?: string;
  /** Present on Ctrl and Alt: armed for one key, or locked. */
  readonly state?: ModState;
  readonly wide?: boolean;
  readonly onPress: () => void;
}

export function KeyButton({ label, name, state, wide, onPress }: KeyButtonProps): JSX.Element {
  const cls = state === 'lock' ? ' is-lock' : state === 'once' ? ' is-once' : '';
  return (
    <button
      type="button"
      className={`tw-key${cls}${wide ? ' is-wide' : ''}`}
      aria-label={name ?? label}
      aria-pressed={state === undefined ? undefined : state !== 'off'}
      onClick={onPress}
    >
      {label}
    </button>
  );
}
