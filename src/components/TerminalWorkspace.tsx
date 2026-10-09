import { type CSSProperties, type JSX, type MutableRefObject, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal, type ILink, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { copyToClipboard } from '../lib/urls';
import { CanvasRenderer, type CellRange, type RenderQuality, type RenderTheme } from '../lib/canvasRenderer';
import { prefersReducedMotion } from '../lib/motion';
import { SCHEMES, SCHEME_IDS, SITE_SCHEME, type TermScheme } from '../lib/termThemes';
import '@xterm/xterm/css/xterm.css';

interface Win {
  readonly id: number;
  /** Name the person gave the tab. Wins over the shell's own title. */
  readonly name?: string;
  /** Server shell id, so a reload or dropped connection reattaches the same shell. */
  readonly sid?: string;
}

type Layout = 'tabs' | 'tile';
type CursorStyle = 'bar' | 'block' | 'underline';
/** `crisp`: one canvas pixel per screen pixel. `ssaa`: rendered at 2x and averaged down. */
type Quality = 'crisp' | 'ssaa';

interface Prefs {
  readonly scheme: string;
  readonly cursorStyle: CursorStyle;
  readonly blink: boolean;
  readonly lineHeight: number;
  readonly quality: Quality;
  readonly weight: 400 | 500;
  readonly boldBright: boolean;
  readonly antialias: 'lcd' | 'gray';
}

const DEFAULT_PREFS: Prefs = {
  scheme: SITE_SCHEME,
  cursorStyle: 'bar',
  blink: true,
  // ASCII art (neofetch, figlet) and box drawing read as one picture at tighter spacing.
  lineHeight: 1.2,
  quality: 'crisp',
  weight: 400,
  boldBright: false,
  antialias: 'lcd',
};

function renderQuality(p: Prefs): RenderQuality {
  return { supersample: p.quality === 'ssaa' ? 2 : 1, weight: p.weight, boldBright: p.boldBright, antialias: p.antialias };
}

/** Sticky modifier from the touch key bar: off, armed for one key, or locked. */
type ModState = 'off' | 'once' | 'lock';

interface Mods {
  readonly ctrl: ModState;
  readonly alt: ModState;
}

const NO_MODS: Mods = { ctrl: 'off', alt: 'off' };

interface SearchOpts {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
}

interface SearchState {
  readonly index: number;
  readonly total: number;
}

/** How the workspace reaches a window's shell. Each window registers one. */
interface Port {
  readonly send: (data: string) => void;
  readonly paste: (text: string) => void;
  readonly search: (query: string, opts: SearchOpts, step: -1 | 0 | 1) => SearchState;
  readonly clearSearch: () => void;
  readonly focus: () => void;
}

type KeyDef =
  | { readonly k: 'esc' }
  | { readonly k: 'tab' }
  | { readonly k: 'csi'; readonly final: string }
  | { readonly k: 'tilde'; readonly n: number }
  | { readonly k: 'text'; readonly value: string };

/** Phones and tablets get the key bar and a smaller font. */
/** Upper bound for keys held before a shell is ready to take them. */
const EARLY_MAX = 4096;
/** Matches the tw-sheet-out animation in motion.css. */
const CLOSE_MS = 220;

/** What a key press sends to a shell, for keys queued before xterm has focus. */
function earlyKey(key: string): string | null {
  if (key.length === 1) return key;
  if (key === 'Enter') return '\r';
  if (key === 'Tab') return '\t';
  if (key === 'Backspace') return '\x7f';
  return null;
}

const COMPACT_QUERY = '(max-width: 820px), (pointer: coarse)';
const COMPACT_FONT_SIZE = 12;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 28;
const SIZE_KEY = 'vps_term_font';
const PREFS_KEY = 'vps_term_prefs';
/** Per browser tab, so a reload reattaches this tab's shells and no other's. */
const WINS_KEY = 'vps_term_wins';

function readStoredSize(): number | null {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (Number.isInteger(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
  } catch {
    /* private mode */
  }
  return null;
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      scheme: typeof raw.scheme === 'string' && SCHEME_IDS.has(raw.scheme) ? raw.scheme : DEFAULT_PREFS.scheme,
      cursorStyle: raw.cursorStyle === 'block' || raw.cursorStyle === 'underline' ? raw.cursorStyle : 'bar',
      blink: raw.blink !== false,
      lineHeight: typeof raw.lineHeight === 'number' && raw.lineHeight >= 1 && raw.lineHeight <= 1.8 ? raw.lineHeight : DEFAULT_PREFS.lineHeight,
      quality: raw.quality === 'ssaa' ? 'ssaa' : 'crisp',
      weight: raw.weight === 500 ? 500 : 400,
      boldBright: raw.boldBright === true,
      antialias: raw.antialias === 'gray' ? 'gray' : 'lcd',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function readWins(): readonly Win[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(WINS_KEY) ?? '[]') as Win[];
    const ok = Array.isArray(raw)
      ? raw.filter((w) => Number.isInteger(w?.id) && w.id > 0).map((w) => ({ id: w.id, name: typeof w.name === 'string' ? w.name : undefined, sid: typeof w.sid === 'string' ? w.sid : undefined }))
      : [];
    if (ok.length > 0) return ok;
  } catch {
    /* private mode */
  }
  return [{ id: 1 }];
}

function store(key: string, value: string | null, session = false): void {
  try {
    const s = session ? sessionStorage : localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Ctrl and Alt applied to one character typed on a soft keyboard. */
function applyMods(data: string, mods: Mods): string {
  let out = data;
  if (mods.ctrl !== 'off' && data.length === 1) {
    const c = data.toUpperCase();
    if (/[A-Z]/.test(c)) out = String.fromCharCode(c.charCodeAt(0) & 0x1f);
    else if (c === '[') out = '\x1b';
    else if (c === '\\') out = '\x1c';
    else if (c === ']') out = '\x1d';
    else if (c === '^') out = '\x1e';
    else if (c === '_') out = '\x1f';
    else if (c === ' ' || c === '@') out = '\x00';
    else if (c === '?') out = '\x7f';
  }
  return mods.alt !== 'off' ? `\x1b${out}` : out;
}

/** Bytes for a key-bar key, with the xterm modifier parameter (1 + alt 2 + ctrl 4) when one is armed. */
function encodeKey(key: KeyDef, mods: Mods): string {
  const m = 1 + (mods.alt !== 'off' ? 2 : 0) + (mods.ctrl !== 'off' ? 4 : 0);
  switch (key.k) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return mods.alt !== 'off' ? '\x1b\t' : '\t';
    case 'csi':
      return m > 1 ? `\x1b[1;${m}${key.final}` : `\x1b[${key.final}`;
    case 'tilde':
      return m > 1 ? `\x1b[${key.n};${m}~` : `\x1b[${key.n}~`;
    case 'text':
      return applyMods(key.value, mods);
  }
}

/** The shell's own title ("user@host: ~/dir") shortened to the directory part. */
function shortTitle(title: string): string {
  return title.replace(/^[^@\s]+@[^:\s]+:\s*/, '').trim();
}

interface WorkspaceProps {
  /** Overlay visible. When false it is only hidden, so every shell keeps running. */
  readonly open: boolean;
  readonly onHide: () => void;
  /** Last window closed: nothing left to keep, the caller unmounts the workspace. */
  readonly onEmpty: () => void;
}

/**
 * Fullscreen terminal workspace. Each window is its own shell on the server
 * (node-pty). `tabs` shows one at a time, `tile` shows them all in a grid.
 * Hiding the overlay keeps the shells alive, and so does reloading the page:
 * windows reattach to their shells by id. Closing a window ends its shell, and
 * closing the last one leaves the workspace.
 */
export function TerminalWorkspace({ open, onHide, onEmpty }: WorkspaceProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [wins, setWins] = useState<readonly Win[]>(readWins);
  const [active, setActive] = useState(() => wins[0]?.id ?? 1);
  const [titles, setTitles] = useState<Readonly<Record<number, string>>>({});
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [layout, setLayout] = useState<Layout>('tabs');
  const [full, setFull] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  const [chosenSize, setChosenSize] = useState<number | null>(readStoredSize);
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [panel, setPanel] = useState<'none' | 'themes'>('none');
  // Keys typed after opening but before the shell's xterm can take focus. They
  // are replayed into the shell once it is ready, so nothing typed is lost.
  const early = useRef('');
  const takeEarly = useCallback(() => {
    const typed = early.current;
    early.current = '';
    return typed;
  }, []);
  // True while the overlay plays its exit animation (.tw.is-closing).
  const [closing, setClosing] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [mods, setModsState] = useState<Mods>(NO_MODS);
  const [find, setFind] = useState<{ open: boolean; query: string; opts: SearchOpts; result: SearchState }>({
    open: false,
    query: '',
    opts: { caseSensitive: false, regex: false },
    result: { index: 0, total: 0 },
  });
  const findInput = useRef<HTMLInputElement>(null);
  const modsRef = useRef<Mods>(NO_MODS);
  const ports = useRef(new Map<number, Port>());
  const siteTheme = useSiteTheme();

  const fontSize = chosenSize ?? (compact ? COMPACT_FONT_SIZE : FONT_SIZE);
  const scheme = useMemo(() => resolveScheme(prefs.scheme, siteTheme), [prefs.scheme, siteTheme]);

  useEffect(() => store(WINS_KEY, JSON.stringify(wins), true), [wins]);

  const setPrefs = (patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      store(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  };

  /** Bigger or smaller text, remembered in this browser. Clicking the size resets it. */
  const resizeText = useCallback(
    (delta: number) => {
      setChosenSize((now) => {
        const base = now ?? (compact ? COMPACT_FONT_SIZE : FONT_SIZE);
        const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, base + delta));
        store(SIZE_KEY, String(next));
        return next;
      });
    },
    [compact],
  );

  const resetText = () => {
    setChosenSize(null);
    store(SIZE_KEY, null);
  };

  const setMods = useCallback((next: Mods) => {
    modsRef.current = next;
    setModsState(next);
  }, []);

  /** A one-shot modifier is spent by the key it was armed for. */
  const modsUsed = useCallback(() => {
    const { ctrl, alt } = modsRef.current;
    if (ctrl !== 'once' && alt !== 'once') return;
    setMods({ ctrl: ctrl === 'once' ? 'off' : ctrl, alt: alt === 'once' ? 'off' : alt });
  }, [setMods]);

  /** Tapping cycles off, one key, locked, off. */
  const cycle = (which: 'ctrl' | 'alt') => {
    const now = modsRef.current[which];
    setMods({ ...modsRef.current, [which]: now === 'off' ? 'once' : now === 'once' ? 'lock' : 'off' });
  };

  const press = (key: KeyDef) => {
    ports.current.get(active)?.send(encodeKey(key, modsRef.current));
    modsUsed();
  };

  const pasteFromClipboard = () => {
    void navigator.clipboard
      .readText()
      .then((text) => ports.current.get(active)?.paste(text))
      .catch(() => undefined);
  };

  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // On phones the on-screen keyboard shrinks the visual viewport. Follow it, so the
  // key bar stays right above the keyboard instead of hiding behind it.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = root.current;
    if (!open || !vv || !el) return;
    const sync = () => {
      el.style.setProperty('--tw-h', `${vv.height}px`);
      el.style.setProperty('--tw-top', `${vv.offsetTop}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [open]);

  const activate = useCallback((id: number) => {
    setActive(id);
    setBusy((b) => {
      if (!b.has(id)) return b;
      const n = new Set(b);
      n.delete(id);
      return n;
    });
  }, []);

  // A new window takes the smallest number not in use, so closing Shell 2 and
  // opening another gives Shell 2 again, not Shell 4.
  const add = useCallback(() => {
    const used = new Set(wins.map((w) => w.id));
    let id = 1;
    while (used.has(id)) id += 1;
    setWins([...wins, { id }]);
    activate(id);
  }, [wins, activate]);

  const close = useCallback(
    (id: number) => {
      const rest = wins.filter((w) => w.id !== id);
      if (rest.length === 0) {
        if (document.fullscreenElement) void document.exitFullscreen();
        store(WINS_KEY, null, true);
        onEmpty();
        return;
      }
      setWins(rest);
      if (active === id) activate(rest[rest.length - 1]?.id ?? active);
    },
    [wins, active, onEmpty, activate],
  );

  /** Move to the previous or next window, wrapping around. */
  const step = useCallback(
    (delta: number) => {
      if (wins.length < 2) return;
      const i = wins.findIndex((w) => w.id === active);
      const next = wins[(i + delta + wins.length) % wins.length];
      if (next) activate(next.id);
    },
    [wins, active, activate],
  );

  const onSid = useCallback((id: number, sid: string | undefined) => {
    setWins((ws) => ws.map((w) => (w.id === id && w.sid !== sid ? { ...w, sid } : w)));
  }, []);

  const onTitle = useCallback((id: number, title: string) => {
    setTitles((t) => (t[id] === title ? t : { ...t, [id]: title }));
  }, []);

  const onActivity = useCallback((id: number) => {
    setBusy((b) => (b.has(id) ? b : new Set(b).add(id)));
  }, []);

  const rename = (id: number, name: string) => {
    const clean = name.trim().slice(0, 40);
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, name: clean || undefined } : w)));
    setRenaming(null);
  };

  // ---- find bar

  const runFind = useCallback(
    (query: string, opts: SearchOpts, dir: -1 | 0 | 1) => {
      const port = ports.current.get(active);
      const result = port && query ? port.search(query, opts, dir) : { index: 0, total: 0 };
      if (!query) port?.clearSearch();
      setFind((f) => ({ ...f, query, opts, result }));
    },
    [active],
  );

  const openFind = useCallback(() => {
    setFind((f) => ({ ...f, open: true }));
    requestAnimationFrame(() => findInput.current?.select());
  }, []);

  const closeFind = useCallback(() => {
    for (const p of ports.current.values()) p.clearSearch();
    setFind((f) => ({ ...f, open: false, result: { index: 0, total: 0 } }));
    ports.current.get(active)?.focus();
  }, [active]);

  // Switching windows with the find bar open searches the new one.
  useEffect(() => {
    if (find.open && find.query) runFind(find.query, find.opts, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The dashboard behind the overlay must not scroll while the terminal is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const hide = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (prefersReducedMotion()) {
      onHide();
      return;
    }
    setClosing(true);
    window.setTimeout(() => {
      setClosing(false);
      onHide();
    }, CLOSE_MS);
  }, [onHide]);

  // Opening: take focus at once so keys never land on the dashboard behind
  // (where "/", "[" and 1-4 are shortcuts). The active shell pulls focus to
  // itself as soon as its xterm is ready; until then keys are queued (early).
  // Layout effect: focus moves before the first paint, so no key slips past.
  useLayoutEffect(() => {
    if (!open) return;
    early.current = '';
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [open]);

  const cols = Math.ceil(Math.sqrt(wins.length));
  const tabLabel = (w: Win): string => w.name || shortTitle(titles[w.id] ?? '') || `Shell ${w.id}`;

  const rootStyle = {
    '--term-bg': scheme.background,
    '--term-fg': scheme.foreground,
    '--term-accent': scheme.cursor,
    '--term-sel': scheme.selection,
  } as CSSProperties;

  return (
    <div
      ref={root}
      className={`tw${open ? '' : ' is-hidden'}${closing ? ' is-closing' : ''}${compact ? ' is-compact' : ''}${scheme.dark ? ' is-term-dark' : ' is-term-light'}`}
      style={rootStyle}
      role="dialog"
      aria-label="Terminal"
      aria-hidden={!open}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!open) return;
        // Focus is still on the overlay itself: the shell is not ready yet.
        if (e.target === e.currentTarget && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const key = earlyKey(e.key);
          if (key !== null) {
            e.preventDefault();
            if (key === '\x7f') early.current = early.current.slice(0, -1);
            else if (early.current.length < EARLY_MAX) early.current += key;
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (panel !== 'none') setPanel('none');
          else if (find.open) closeFind();
          else hide();
          return;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          openFind();
          return;
        }
        // Window shortcuts. xterm is told to ignore these keys, so the shell never sees them.
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === 'n') add();
        else if (key === 'w') close(active);
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
        else if (/^[1-9]$/.test(e.key)) {
          const w = wins[Number(e.key) - 1];
          if (w) activate(w.id);
        } else return;
        e.preventDefault();
      }}
    >
      <div className="tw-bar">
        <div className="tw-tabs" role="tablist">
          {wins.map((w, i) => (
            <div
              key={w.id}
              className={`tw-tab${w.id === active ? ' is-active' : ''}${busy.has(w.id) ? ' is-busy' : ''}`}
              title={titles[w.id] ?? undefined}
            >
              {renaming === w.id ? (
                <input
                  className="tw-rename"
                  autoFocus
                  defaultValue={w.name ?? tabLabel(w)}
                  aria-label="Window name"
                  onBlur={(e) => rename(w.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') rename(w.id, e.currentTarget.value);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={w.id === active}
                  className="tw-tab-label"
                  onClick={() => activate(w.id)}
                  onDoubleClick={() => setRenaming(w.id)}
                >
                  <span className="tw-tab-dot" aria-hidden="true" />
                  <span className="tw-tab-text">{tabLabel(w)}</span>
                  {i < 9 && <kbd className="tw-tab-kbd">{i + 1}</kbd>}
                </button>
              )}
              <button type="button" className="tw-x" aria-label={`Close ${tabLabel(w)}`} onClick={() => close(w.id)}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="tw-btn tw-add" onClick={add} aria-label="New window" title="New window (Alt+N)">
            +
          </button>
        </div>

        <div className="tw-actions">
          <button type="button" className={`tw-btn tw-btn-text${find.open ? ' is-on' : ''}`} onClick={find.open ? closeFind : openFind} title="Find (Ctrl+Shift+F)">
            Find
          </button>
          <div className="tw-size" role="group" aria-label="Text size">
            <button
              type="button"
              className="tw-btn tw-btn-text"
              onClick={() => resizeText(-1)}
              disabled={fontSize <= MIN_FONT_SIZE}
              aria-label="Smaller text"
              title="Smaller text (Ctrl+wheel)"
            >
              A−
            </button>
            <button type="button" className="tw-btn tw-size-now" onClick={resetText} title="Reset text size">
              {fontSize}px
            </button>
            <button
              type="button"
              className="tw-btn tw-btn-text"
              onClick={() => resizeText(1)}
              disabled={fontSize >= MAX_FONT_SIZE}
              aria-label="Bigger text"
              title="Bigger text (Ctrl+wheel)"
            >
              A+
            </button>
          </div>
          <div className="tw-pop-wrap">
            <button
              type="button"
              className={`tw-btn tw-btn-text tw-theme-btn${panel === 'themes' ? ' is-on' : ''}`}
              onClick={() => setPanel((p) => (p === 'themes' ? 'none' : 'themes'))}
              aria-expanded={panel === 'themes'}
              title="Theme and cursor"
            >
              <span className="tw-swatch-mini" style={{ background: scheme.background, borderColor: scheme.cursor }} aria-hidden="true" />
              Theme
            </button>
            {panel === 'themes' && (
              <ThemePanel prefs={prefs} siteTheme={siteTheme} onChange={setPrefs} onClose={() => setPanel('none')} />
            )}
          </div>
          <button
            type="button"
            className="tw-btn tw-btn-text"
            onClick={() => setLayout((l) => (l === 'tabs' ? 'tile' : 'tabs'))}
            title={layout === 'tabs' ? 'Show all windows side by side' : 'Show one window at a time'}
          >
            {layout === 'tabs' ? 'Tile' : 'Tabs'}
          </button>
          {document.fullscreenEnabled && (
            <button type="button" className="tw-btn tw-btn-text" onClick={toggleFullscreen} title="Browser fullscreen">
              {full ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          )}
          <button type="button" className="tw-btn tw-btn-text" onClick={hide} title="Back to dashboard. Shells keep running.">
            Hide
          </button>
        </div>
      </div>

      {find.open && (
        <div className="tw-find" role="search">
          <input
            ref={findInput}
            className="tw-find-input"
            placeholder="Find in scrollback"
            aria-label="Find in scrollback"
            value={find.query}
            spellCheck={false}
            onChange={(e) => runFind(e.currentTarget.value, find.opts, 0)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runFind(find.query, find.opts, e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="tw-find-count" aria-live="polite">
            {find.query ? (find.result.total ? `${find.result.index + 1} / ${find.result.total}` : 'No results') : ''}
          </span>
          <button
            type="button"
            className={`tw-btn tw-chip${find.opts.caseSensitive ? ' is-on' : ''}`}
            aria-pressed={find.opts.caseSensitive}
            title="Match case"
            onClick={() => runFind(find.query, { ...find.opts, caseSensitive: !find.opts.caseSensitive }, 0)}
          >
            Aa
          </button>
          <button
            type="button"
            className={`tw-btn tw-chip${find.opts.regex ? ' is-on' : ''}`}
            aria-pressed={find.opts.regex}
            title="Regular expression"
            onClick={() => runFind(find.query, { ...find.opts, regex: !find.opts.regex }, 0)}
          >
            .*
          </button>
          <button type="button" className="tw-btn tw-chip" title="Previous (Shift+Enter)" aria-label="Previous match" onClick={() => runFind(find.query, find.opts, -1)}>
            ↑
          </button>
          <button type="button" className="tw-btn tw-chip" title="Next (Enter)" aria-label="Next match" onClick={() => runFind(find.query, find.opts, 1)}>
            ↓
          </button>
          <button type="button" className="tw-btn tw-chip" aria-label="Close find" onClick={closeFind}>
            ×
          </button>
        </div>
      )}

      <div
        className={`tw-body${layout === 'tile' ? ' is-tile' : ''}`}
        style={layout === 'tile' ? { gridTemplateColumns: `repeat(${compact ? 1 : cols}, minmax(0, 1fr))` } : undefined}
      >
        {wins.map((w) => (
          <TerminalView
            key={w.id}
            id={w.id}
            title={tabLabel(w)}
            sid={w.sid}
            fontSize={fontSize}
            prefs={prefs}
            scheme={scheme}
            registry={ports}
            modsRef={modsRef}
            onModsUsed={modsUsed}
            shown={layout === 'tile' || w.id === active}
            focused={open && w.id === active}
            current={w.id === active}
            onFocus={() => activate(w.id)}
            onSid={onSid}
            onTitle={onTitle}
            onActivity={onActivity}
            onZoom={resizeText}
            onFind={openFind}
            takeEarly={takeEarly}
          />
        ))}
      </div>

      {compact && (
        <div
          className="tw-keys"
          role="toolbar"
          aria-label="Terminal keys"
          // Keys must not take focus from the shell, or the on-screen keyboard closes.
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
        >
          <KeyButton label="Esc" onPress={() => press({ k: 'esc' })} />
          <KeyButton label="Tab" onPress={() => press({ k: 'tab' })} />
          <KeyButton label="Ctrl" state={mods.ctrl} onPress={() => cycle('ctrl')} />
          <KeyButton label="Alt" state={mods.alt} onPress={() => cycle('alt')} />
          <KeyButton label="←" name="Left" onPress={() => press({ k: 'csi', final: 'D' })} />
          <KeyButton label="↓" name="Down" onPress={() => press({ k: 'csi', final: 'B' })} />
          <KeyButton label="↑" name="Up" onPress={() => press({ k: 'csi', final: 'A' })} />
          <KeyButton label="→" name="Right" onPress={() => press({ k: 'csi', final: 'C' })} />
          <KeyButton label="Home" onPress={() => press({ k: 'csi', final: 'H' })} />
          <KeyButton label="End" onPress={() => press({ k: 'csi', final: 'F' })} />
          <KeyButton label="PgUp" onPress={() => press({ k: 'tilde', n: 5 })} />
          <KeyButton label="PgDn" onPress={() => press({ k: 'tilde', n: 6 })} />
          {['/', '-', '|', '~', '`', '\\', '_', '$'].map((ch) => (
            <KeyButton key={ch} label={ch} onPress={() => press({ k: 'text', value: ch })} />
          ))}
          <KeyButton label="^C" name="Control C, interrupt" onPress={() => ports.current.get(active)?.send('\x03')} />
          <KeyButton label="^D" name="Control D, end of input" onPress={() => ports.current.get(active)?.send('\x04')} />
          {typeof navigator.clipboard?.readText === 'function' && <KeyButton label="Paste" onPress={pasteFromClipboard} />}
        </div>
      )}
    </div>
  );
}

interface KeyButtonProps {
  readonly label: string;
  /** Spoken name when the label is a symbol. */
  readonly name?: string;
  /** Present on Ctrl and Alt: armed for one key, or locked. */
  readonly state?: ModState;
  readonly onPress: () => void;
}

function KeyButton({ label, name, state, onPress }: KeyButtonProps): JSX.Element {
  const cls = state === 'lock' ? ' is-lock' : state === 'once' ? ' is-once' : '';
  return (
    <button
      type="button"
      className={`tw-key${cls}`}
      aria-label={name ?? label}
      aria-pressed={state === undefined ? undefined : state !== 'off'}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ themes

const FONT_SIZE = 14;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * ANSI colours drawn from the dashboard palette, for the `site` scheme.
 */
const ANSI_DARK = [
  '#4a4a5a', '#ff4560', '#00ff9c', '#ffd400', '#3d9bff', '#e056ff', '#00e5ff', '#e6e6e6',
  '#8b8ba0', '#ff7088', '#69ffc0', '#ffea5c', '#7cbaff', '#f08cff', '#66f0ff', '#ffffff',
] as const;

const ANSI_LIGHT = [
  '#0d0d0d', '#d92d20', '#167347', '#8f5f08', '#2f6fe0', '#8e4ec6', '#1b8fa5', '#a3a3a3',
  '#6e6e6e', '#ef4444', '#1f8f5a', '#a8700a', '#4c8bf5', '#a463d9', '#2aa8c0', '#424242',
] as const;

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1] ?? '0', 16)}, ${parseInt(m[2] ?? '0', 16)}, ${parseInt(m[3] ?? '0', 16)}, ${alpha})`;
}

/** The site's light/dark choice, kept current as the person toggles it. */
function useSiteTheme(): 'dark' | 'light' {
  const read = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [t, setT] = useState<'dark' | 'light'>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setT(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return t;
}

/** A concrete scheme: the chosen fixed one, or the site palette for `site`. */
function resolveScheme(id: string, site: 'dark' | 'light'): TermScheme {
  const fixed = SCHEMES.find((x) => x.id === id);
  if (fixed) return fixed;
  const dark = site === 'dark';
  const accent = token('--accent') || (dark ? '#f5f5f5' : '#0d0d0d');
  return {
    id: SITE_SCHEME,
    name: 'Dashboard',
    dark,
    background: token('--surface') || (dark ? '#0d0d0d' : '#f9f9f9'),
    foreground: token('--text') || (dark ? '#f5f5f5' : '#0d0d0d'),
    // Dark: a neon cursor to match the vivid palette; light keeps the accent.
    cursor: dark ? '#00ff9c' : accent,
    selection: withAlpha(accent, dark ? 0.35 : 0.28),
    ansi: dark ? ANSI_DARK : ANSI_LIGHT,
  };
}

function xtermTheme(s: TermScheme): ITheme {
  const t: Record<string, string> = {
    background: s.background,
    foreground: s.foreground,
    cursor: s.cursor,
    cursorAccent: s.background,
    selectionBackground: s.selection,
  };
  ANSI_KEYS.forEach((k, i) => {
    t[k] = s.ansi[i] ?? '#888888';
  });
  return t as ITheme;
}

function renderThemeOf(s: TermScheme): RenderTheme {
  return { foreground: s.foreground, background: s.background, cursor: s.cursor, selection: s.selection, ansi: s.ansi };
}

interface ThemePanelProps {
  readonly prefs: Prefs;
  readonly siteTheme: 'dark' | 'light';
  readonly onChange: (p: Partial<Prefs>) => void;
  readonly onClose: () => void;
}

function ThemePanel({ prefs, siteTheme, onChange, onClose }: ThemePanelProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.tw-theme-btn')) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const all = [resolveScheme(SITE_SCHEME, siteTheme), ...SCHEMES];
  return (
    <div ref={ref} className="tw-pop" role="dialog" aria-label="Terminal theme">
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
              <span style={{ color: s.ansi[2] }}>❯</span> <span style={{ color: s.ansi[4] }}>~/src</span>{' '}
              <span style={{ color: s.ansi[3] }}>git</span>
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
          <button key={c} type="button" className={`tw-btn tw-chip${prefs.cursorStyle === c ? ' is-on' : ''}`} aria-pressed={prefs.cursorStyle === c} onClick={() => onChange({ cursorStyle: c })}>
            {c === 'bar' ? '▏ Bar' : c === 'block' ? '█ Block' : '▁ Underline'}
          </button>
        ))}
        <button type="button" className={`tw-btn tw-chip${prefs.blink ? ' is-on' : ''}`} aria-pressed={prefs.blink} onClick={() => onChange({ blink: !prefs.blink })}>
          Pulse
        </button>
      </div>
      <label className="tw-range">
        <span>Line height</span>
        <input
          type="range"
          min={1}
          max={1.8}
          step={0.05}
          value={prefs.lineHeight}
          onChange={(e) => onChange({ lineHeight: Number(e.currentTarget.value) })}
        />
        <output>{prefs.lineHeight.toFixed(2)}</output>
      </label>
      <div className="tw-pop-head">Rendering</div>
      <div className="tw-seg" role="group" aria-label="Render quality">
        <button
          type="button"
          className={`tw-btn tw-chip${prefs.quality === 'crisp' ? ' is-on' : ''}`}
          aria-pressed={prefs.quality === 'crisp'}
          title="One canvas pixel per screen pixel, LCD antialiasing where the system has it. Sharpest."
          onClick={() => onChange({ quality: 'crisp' })}
        >
          Crisp · native
        </button>
        <button
          type="button"
          className={`tw-btn tw-chip${prefs.quality === 'ssaa' ? ' is-on' : ''}`}
          aria-pressed={prefs.quality === 'ssaa'}
          title="Rendered at twice the screen resolution and averaged down. Smoother, slightly softer."
          onClick={() => onChange({ quality: 'ssaa' })}
        >
          4K · 2× supersample
        </button>
      </div>
      <div className="tw-seg tw-seg-gap" role="group" aria-label="Antialiasing">
        <button
          type="button"
          className={`tw-btn tw-chip${prefs.antialias === 'lcd' ? ' is-on' : ''}`}
          aria-pressed={prefs.antialias === 'lcd'}
          disabled={prefs.quality === 'ssaa'}
          title="Subpixel (ClearType-style) smoothing, the same as the rest of the page uses on this system"
          onClick={() => onChange({ antialias: 'lcd' })}
        >
          Subpixel · auto
        </button>
        <button
          type="button"
          className={`tw-btn tw-chip${prefs.antialias === 'gray' || prefs.quality === 'ssaa' ? ' is-on' : ''}`}
          aria-pressed={prefs.antialias === 'gray' || prefs.quality === 'ssaa'}
          disabled={prefs.quality === 'ssaa'}
          title="Greyscale smoothing. Pick this if letters show coloured edges (OLED or rotated screens)"
          onClick={() => onChange({ antialias: 'gray' })}
        >
          Greyscale
        </button>
      </div>
      <div className="tw-seg tw-seg-gap" role="group" aria-label="Text weight">
        <button type="button" className={`tw-btn tw-chip${prefs.weight === 400 ? ' is-on' : ''}`} aria-pressed={prefs.weight === 400} onClick={() => onChange({ weight: 400 })}>
          Regular
        </button>
        <button type="button" className={`tw-btn tw-chip${prefs.weight === 500 ? ' is-on' : ''}`} aria-pressed={prefs.weight === 500} onClick={() => onChange({ weight: 500 })}>
          Medium
        </button>
        <button
          type="button"
          className={`tw-btn tw-chip${prefs.boldBright ? ' is-on' : ''}`}
          aria-pressed={prefs.boldBright}
          title="Bold text in the eight base colours uses the bright ones, like classic xterm"
          onClick={() => onChange({ boldBright: !prefs.boldBright })}
        >
          Bold = bright
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

/**
 * Selects what is typed after the prompt on the cursor's line, following the line
 * across wraps and returns the selected text. The prompt ends at the first "$", "#" or "%" followed by a space.
 */
function selectCommandLine(t: Terminal): string | null {
  const buf = t.buffer.active;
  const cursorRow = buf.baseY + buf.cursorY;
  let first = cursorRow;
  while (first > 0 && buf.getLine(first)?.isWrapped) first -= 1;
  let last = cursorRow;
  while (buf.getLine(last + 1)?.isWrapped) last += 1;

  // Untrimmed rows are exactly `cols` wide, so a string index maps straight to a cell.
  let text = '';
  for (let r = first; r <= last; r++) text += buf.getLine(r)?.translateToString(false) ?? '';
  text = text.replace(/\s+$/, '');

  const prompt = /^.*?[$#%](?: |$)/.exec(text);
  const from = prompt ? prompt[0].length : 0;
  const length = text.length - from;
  if (length <= 0) {
    t.clearSelection();
    return null;
  }
  t.select(from % t.cols, first + Math.floor(from / t.cols), length);
  return t.getSelection();
}

const MAX_MATCHES = 5000;

/**
 * Every match in the buffer, scrollback included. Wrapped rows are joined so a
 * match can cross a soft wrap; a match is returned as its start cell and length,
 * and `split` breaks it into one range per screen row for drawing.
 */
function findAll(t: Terminal, query: string, opts: SearchOpts): CellRange[] {
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const buf = t.buffer.active;
  const cols = t.cols;
  const out: CellRange[] = [];
  let row = 0;
  while (row < buf.length && out.length < MAX_MATCHES) {
    const first = row;
    let text = buf.getLine(row)?.translateToString(false) ?? '';
    row += 1;
    while (row < buf.length && buf.getLine(row)?.isWrapped) {
      text += buf.getLine(row)?.translateToString(false) ?? '';
      row += 1;
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < MAX_MATCHES) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      out.push({ row: first + Math.floor(m.index / cols), col: m.index % cols, len: m[0].length });
    }
  }
  return out;
}

function split(r: CellRange, cols: number): CellRange[] {
  const parts: CellRange[] = [];
  let { row, col, len } = r;
  while (len > 0) {
    const n = Math.min(len, cols - col);
    parts.push({ row, col, len: n });
    len -= n;
    row += 1;
    col = 0;
  }
  return parts;
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/g;

/** Readline: End, then kill back to the start of the line. Clears the whole typed command. */
const CLEAR_COMMAND = '\x05\x15';

type Link = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'exited' | 'elsewhere';

const LINK_LABEL: Record<Link, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Disconnected',
  exited: 'Exited',
  elsewhere: 'Opened in another tab',
};

// ------------------------------------------------------------------ one window

interface ViewProps {
  readonly id: number;
  readonly title: string;
  readonly sid: string | undefined;
  readonly fontSize: number;
  readonly prefs: Prefs;
  readonly scheme: TermScheme;
  readonly registry: MutableRefObject<Map<number, Port>>;
  readonly modsRef: MutableRefObject<Mods>;
  readonly onModsUsed: () => void;
  readonly shown: boolean;
  readonly focused: boolean;
  readonly current: boolean;
  readonly onFocus: () => void;
  readonly onSid: (id: number, sid: string | undefined) => void;
  readonly onTitle: (id: number, title: string) => void;
  readonly onActivity: (id: number) => void;
  readonly onZoom: (delta: number) => void;
  readonly onFind: () => void;
  /** Keys typed before this shell could take focus; empties the queue. */
  readonly takeEarly: () => string;
}

interface Menu {
  readonly x: number;
  readonly y: number;
}

/** One xterm bound to its own server shell. Reconnects on its own and reattaches by id. */
function TerminalView(props: ViewProps): JSX.Element {
  const { id, title, fontSize, prefs, scheme, registry, modsRef, onModsUsed, shown, focused, current, onFocus } = props;
  const host = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const painterRef = useRef<CanvasRenderer | null>(null);
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  // Callbacks read through a ref, so the mount effect runs once and never goes stale.
  const live = useRef(props);
  live.current = props;
  const [xt, setXt] = useState<Terminal | null>(null);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<Link>('connecting');
  const [latency, setLatency] = useState<number | null>(null);
  const [size, setSize] = useState('');
  const [mode, setMode] = useState('');
  const [marks, setMarks] = useState<{ all: readonly CellRange[]; current: CellRange | null }>({ all: [], current: null });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [bell, setBell] = useState(0);
  const [render, setRender] = useState('');

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let cancelled = false;
    let unmount: () => void = () => undefined;

    const mount = (el: HTMLElement): (() => void) => {
      const p = live.current.prefs;
      const t = new Terminal({
        allowProposedApi: true,
        cursorBlink: p.blink,
        cursorStyle: p.cursorStyle,
        cursorWidth: 2,
        fontFamily: FONT_FAMILY,
        fontSize: live.current.fontSize,
        fontWeight: p.weight === 500 ? '500' : '400',
        fontWeightBold: '700',
        drawBoldTextInBrightColors: p.boldBright,
        lineHeight: p.lineHeight,
        scrollback: 10000,
        macOptionIsMeta: true,
        rightClickSelectsWord: false,
        theme: xtermTheme(schemeRef.current),
      });
      const fit = new FitAddon();
      fitRef.current = fit;
      t.loadAddon(fit);
      const unicode = new Unicode11Addon();
      t.loadAddon(unicode);
      t.unicode.activeVersion = '11';
      t.open(el);
      term.current = t;

      // xterm keeps the buffer, keyboard and mouse; this canvas draws the screen.
      const painter = new CanvasRenderer(t, {
        fontFamily: FONT_FAMILY,
        getTheme: () => renderThemeOf(schemeRef.current),
        onRenderSize: (w, h, scale, ss) => setRender(`${ss ? 'SSAA ' : ''}${w}×${h} @${Number(scale.toFixed(2))}×`),
      });
      painter.setQuality(renderQuality(p));
      painter.attach();
      painter.setFocused(document.activeElement === t.textarea);
      const onFocusIn = () => painter.setFocused(true);
      const onFocusOut = () => painter.setFocused(false);
      t.textarea?.addEventListener('focus', onFocusIn);
      t.textarea?.addEventListener('blur', onFocusOut);
      painterRef.current = painter;
      fit.fit();

      // ---- links: plain URLs are clickable, underlined on hover by the canvas
      const links = t.registerLinkProvider({
        provideLinks: (y, cb) => {
          const text = t.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
          const found: ILink[] = [];
          URL_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = URL_RE.exec(text))) {
            const url = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
            const x1 = m.index;
            const x2 = m.index + url.length - 1;
            found.push({
              range: { start: { x: x1 + 1, y }, end: { x: x2 + 1, y } },
              text: url,
              decorations: { pointerCursor: true, underline: false },
              activate: (_e, u) => window.open(u, '_blank', 'noopener,noreferrer'),
              hover: () => painter.setHover({ x1, y1: y - 1, x2, y2: y - 1 }),
              leave: () => painter.setHover(null),
            });
          }
          cb(found.length ? found : undefined);
        },
      });

      // ---- connection
      let ws: WebSocket | null = null;
      let connected = false;
      let sid = live.current.sid;
      let retries = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let ending = false;
      // Typed before the shell first answers: held, then sent on connect.
      let everConnected = false;
      let pending = '';
      const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
      const input = (data: string) => {
        if (connected) send({ type: 'input', data });
        else if (!everConnected && pending.length < EARLY_MAX) pending += data;
      };

      let lastQuery = '';
      let lastOpts: SearchOpts = { caseSensitive: false, regex: false };
      let hits: CellRange[] = [];
      let hitIndex = 0;
      const showHits = () => {
        const cur = hits[hitIndex] ?? null;
        const parts = hits.flatMap((h) => split(h, t.cols));
        painter.setMarks(parts, cur ? (split(cur, t.cols)[0] ?? null) : null);
        setMarks({ all: hits, current: cur });
        if (cur) {
          const buf = t.buffer.active;
          if (cur.row < buf.viewportY || cur.row >= buf.viewportY + t.rows) t.scrollToLine(Math.max(0, cur.row - Math.floor(t.rows / 2)));
        }
      };

      registry.current.set(id, {
        send: input,
        paste: (text) => t.paste(text),
        focus: () => t.focus(),
        search: (q, opts, dir) => {
          const changed = q !== lastQuery || opts.caseSensitive !== lastOpts.caseSensitive || opts.regex !== lastOpts.regex;
          if (changed || dir === 0) {
            hits = findAll(t, q, opts);
            lastQuery = q;
            lastOpts = opts;
            // Start from the match nearest the bottom of the screen, where the person is looking.
            const bottom = t.buffer.active.viewportY + t.rows;
            let i = hits.length - 1;
            while (i > 0 && (hits[i]?.row ?? 0) >= bottom) i -= 1;
            hitIndex = Math.max(0, i);
          } else if (hits.length) {
            hitIndex = (hitIndex + dir + hits.length) % hits.length;
          }
          showHits();
          return { index: hitIndex, total: hits.length };
        },
        clearSearch: () => {
          hits = [];
          lastQuery = '';
          painter.setMarks([], null);
          setMarks({ all: [], current: null });
        },
      });

      // Text selected by Ctrl+A. While that exact selection is still active, typing or
      // Backspace replaces it, like an editor. Mouse selections are left alone: their
      // position cannot be mapped to the shell's cursor safely.
      let cmdSel: string | null = null;
      const replacing = () => cmdSel !== null && t.hasSelection() && t.getSelection() === cmdSel;
      const dropSelection = () => {
        input(CLEAR_COMMAND);
        t.clearSelection();
        cmdSel = null;
      };

      // Editor-style keys. Returning false stops xterm from handling the key.
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        // Escape leaves the workspace and Alt+N/W/Left/Right/1-9 manage windows. All are
        // handled on the overlay, and none of them should reach the shell.
        if (e.key === 'Escape') return false;
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^(n|w|ArrowLeft|ArrowRight|[1-9])$/i.test(e.key)) return false;
        if (e.ctrlKey && e.shiftKey && (e.key === 'f' || e.key === 'F')) return false;
        if (replacing() && !e.altKey && !e.metaKey) {
          if (e.key === 'Backspace' || e.key === 'Delete') {
            dropSelection();
            return false;
          }
          // A typed character replaces the selection: clear it, then xterm sends the character.
          if (e.key.length === 1 && !e.ctrlKey) dropSelection();
        }
        // Ctrl+Backspace deletes a word, same as Alt+Backspace (ESC DEL).
        if (e.key === 'Backspace' && e.ctrlKey && !e.altKey && !e.metaKey) {
          input('\x1b\x7f');
          return false;
        }
        // Ctrl+A selects the command being typed (the text after the prompt). The shell's own Ctrl+A (start of line) is Alt+A
        // instead, because Chrome keeps Ctrl+Shift+A for itself.
        if ((e.key === 'a' || e.key === 'A') && !e.metaKey) {
          if (e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            cmdSel = selectCommandLine(t);
            return false;
          }
          if (e.altKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            input('\x01');
            return false;
          }
        }
        // Ctrl+V pastes. Not handled here, so the browser's paste event reaches xterm.
        if ((e.key === 'v' || e.key === 'V') && e.ctrlKey && !e.altKey) return false;
        // Ctrl+C copies when text is selected, otherwise it stays an interrupt.
        if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && !e.shiftKey && !e.altKey && t.hasSelection()) {
          void copyToClipboard(t.getSelection());
          t.clearSelection();
          return false;
        }
        return true;
      });

      // Select text and, after 2 seconds with the selection unchanged, it is copied.
      let copyTimer: ReturnType<typeof setTimeout> | undefined;
      let flash: ReturnType<typeof setTimeout> | undefined;
      const selection = t.onSelectionChange(() => {
        clearTimeout(copyTimer);
        if (!t.hasSelection()) return;
        copyTimer = setTimeout(() => {
          const text = t.getSelection();
          if (!text) return;
          void copyToClipboard(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            clearTimeout(flash);
            flash = setTimeout(() => setCopied(false), 1200);
            t.focus();
          });
        }, 2000);
      });

      const status = (msg: string, color = 33) => t.write(`\r\n\x1b[${color}m${msg}\x1b[0m\r\n`);

      const connect = (fresh = false) => {
        clearTimeout(retryTimer);
        if (fresh) sid = undefined;
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const q = new URLSearchParams({ cols: String(t.cols), rows: String(t.rows) });
        if (sid) q.set('sid', sid);
        const socket = new WebSocket(`${proto}://${window.location.host}/api/terminal?${q}`);
        ws = socket;
        connected = false;
        let gotReplay = false;
        socket.onmessage = (e) => {
          let msg: { t?: string; d?: string; sid?: string; resumed?: boolean; mode?: string; code?: number; ts?: number };
          try {
            msg = JSON.parse(String(e.data));
          } catch {
            return;
          }
          if (msg.t === 'hello' && msg.sid) {
            connected = true;
            retries = 0;
            everConnected = true;
            if (pending) {
              send({ type: 'input', data: pending });
              pending = '';
            }
            if (sid && !msg.resumed) status('[previous shell has ended — this is a new one]', 90);
            if (msg.resumed) {
              // The replay rebuilds the screen from scratch.
              t.reset();
              gotReplay = true;
            }
            sid = msg.sid;
            live.current.onSid(id, sid);
            setMode(msg.mode ?? '');
            setLink('live');
            send({ type: 'resize', cols: t.cols, rows: t.rows });
          } else if (msg.t === 'o' && msg.d) {
            t.write(msg.d);
            if (gotReplay) {
              gotReplay = false;
              // Full-screen apps repaint for the current size once the replay is in.
              setTimeout(() => send({ type: 'redraw' }), 60);
            }
            if (!live.current.current || document.hidden) live.current.onActivity(id);
          } else if (msg.t === 'exit') {
            ending = true;
            setLink('exited');
            status(`[process exited${msg.code ? ` with ${msg.code}` : ''} — press Enter for a new shell]`);
          } else if (msg.t === 'pong' && typeof msg.ts === 'number') {
            setLatency(Math.max(0, Math.round(performance.now() - msg.ts)));
          }
        };
        socket.onclose = (ev) => {
          if (ws !== socket) return;
          connected = false;
          setLatency(null);
          if (ending || ev.code === 4401 || ev.code === 1011) {
            if (ev.code === 4401) status('[logged out]', 31);
            if (!ending) setLink('offline');
            sid = undefined;
            live.current.onSid(id, undefined);
            return;
          }
          if (ev.code === 4409) {
            setLink('elsewhere');
            status('[this shell was opened in another tab — press Enter to take it back]');
            return;
          }
          // Dropped: try to reattach on our own, backing off.
          if (retries < 8) {
            setLink('reconnecting');
            const wait = Math.min(8000, 400 * 2 ** retries);
            retries += 1;
            retryTimer = setTimeout(() => connect(), wait);
          } else {
            setLink('offline');
            status('[disconnected — press Enter to reconnect]');
          }
        };
      };
      connect();

      const ping = setInterval(() => {
        if (connected && !document.hidden) send({ type: 'ping', ts: performance.now() });
      }, 4000);

      const data = t.onData((raw) => {
        // Ctrl or Alt armed on the key bar applies to the next character typed.
        const mods = modsRef.current;
        const armed = mods.ctrl !== 'off' || mods.alt !== 'off';
        const out = armed ? applyMods(raw, mods) : raw;
        if (armed) onModsUsed();
        if (connected) send({ type: 'input', data: out });
        else if (!everConnected && ws?.readyState === WebSocket.CONNECTING) input(out);
        else if (out === '\r' && ws?.readyState !== WebSocket.CONNECTING && ws?.readyState !== WebSocket.OPEN) {
          const fresh = ending;
          ending = false;
          retries = 0;
          setLink('connecting');
          connect(fresh);
        }
      });
      // Pasting over a Ctrl+A selection replaces it too.
      const onPaste = () => {
        if (replacing()) dropSelection();
      };
      t.textarea?.addEventListener('paste', onPaste, true);
      const resize = t.onResize(({ cols, rows }) => {
        setSize(`${cols}×${rows}`);
        send({ type: 'resize', cols, rows });
        if (hits.length) showHits();
      });
      setSize(`${t.cols}×${t.rows}`);
      const titleSub = t.onTitleChange((s) => live.current.onTitle(id, s));
      const bellSub = t.onBell(() => {
        setBell((n) => n + 1);
        if (!live.current.current) live.current.onActivity(id);
      });

      // Ctrl+wheel zooms the text, like a browser page.
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        live.current.onZoom(e.deltaY < 0 ? 1 : -1);
      };
      el.addEventListener('wheel', onWheel, { passive: false, capture: true });

      // Fires whenever the window changes size or goes from hidden to shown.
      const observer = new ResizeObserver(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
      });
      observer.observe(el);
      setXt(t);

      return () => {
        // Closing the window ends its shell. A page unload never gets here, so a
        // reload leaves the shell running for the next page to reattach.
        send({ type: 'kill' });
        registry.current.delete(id);
        fitRef.current = null;
        clearTimeout(retryTimer);
        clearInterval(ping);
        t.textarea?.removeEventListener('focus', onFocusIn);
        t.textarea?.removeEventListener('blur', onFocusOut);
        el.removeEventListener('wheel', onWheel, { capture: true });
        painter.dispose();
        painterRef.current = null;
        t.textarea?.removeEventListener('paste', onPaste, true);
        clearTimeout(copyTimer);
        clearTimeout(flash);
        selection.dispose();
        links.dispose();
        titleSub.dispose();
        bellSub.dispose();
        observer.disconnect();
        data.dispose();
        resize.dispose();
        const old = ws;
        ws = null;
        old?.close();
        term.current = null;
        setXt(null);
        t.dispose();
      };
    };

    // xterm measures a character cell when it opens, so the font has to be loaded first.
    void document.fonts
      .load(`400 ${FONT_SIZE}px "JetBrains Mono"`)
      .then(() => Promise.all([
        document.fonts.load(`500 ${FONT_SIZE}px "JetBrains Mono"`),
        document.fonts.load(`700 ${FONT_SIZE}px "JetBrains Mono"`),
        document.fonts.load(`italic 400 ${FONT_SIZE}px "JetBrains Mono"`),
      ]))
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) unmount = mount(container);
      });

    return () => {
      cancelled = true;
      unmount();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focused || !shown || !term.current) return;
    term.current.focus();
    const typed = live.current.takeEarly();
    if (typed) registry.current.get(id)?.send(typed);
  }, [focused, shown, xt, registry, id]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.fontSize = fontSize;
    t.options.lineHeight = prefs.lineHeight;
    t.options.cursorStyle = prefs.cursorStyle;
    t.options.cursorBlink = prefs.blink;
    t.options.fontWeight = prefs.weight === 500 ? '500' : '400';
    t.options.drawBoldTextInBrightColors = prefs.boldBright;
    fitRef.current?.fit();
    painterRef.current?.setQuality(renderQuality(prefs));
    painterRef.current?.requestDraw();
  }, [fontSize, prefs.lineHeight, prefs.cursorStyle, prefs.blink, prefs.weight, prefs.boldBright, prefs.quality, prefs.antialias, xt]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.theme = xtermTheme(scheme);
    painterRef.current?.refreshTheme();
  }, [scheme, xt]);

  useEffect(() => {
    if (!bell || !win.current) return;
    const el = win.current;
    el.classList.remove('is-bell');
    void el.offsetWidth;
    el.classList.add('is-bell');
  }, [bell]);

  const menuAction = (what: 'copy' | 'paste' | 'all' | 'clear' | 'find' | 'top' | 'bottom') => {
    const t = term.current;
    setMenu(null);
    if (!t) return;
    if (what === 'copy' && t.hasSelection()) void copyToClipboard(t.getSelection());
    else if (what === 'paste') void navigator.clipboard?.readText().then((x) => t.paste(x)).catch(() => undefined);
    else if (what === 'all') t.selectAll();
    else if (what === 'clear') t.clear();
    else if (what === 'find') props.onFind();
    else if (what === 'top') t.scrollToTop();
    else if (what === 'bottom') t.scrollToBottom();
    t.focus();
  };

  return (
    <section
      ref={win}
      className={`tw-win${shown ? '' : ' is-off'}${current ? ' is-current' : ''} is-${link}`}
      aria-label={title}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        const box = win.current?.getBoundingClientRect();
        if (!box || e.shiftKey) return;
        e.preventDefault();
        setMenu({ x: e.clientX - box.left, y: e.clientY - box.top });
      }}
      onClick={() => menu && setMenu(null)}
    >
      <div className="tw-stage">
        <div ref={host} className="tw-term" />
        {xt && <ScrollRail term={xt} marks={marks.all} current={marks.current} />}
        {xt && <JumpPill term={xt} />}
      </div>
      <footer className="tw-status">
        <span className={`tw-led is-${link}`} aria-hidden="true" />
        <span>{LINK_LABEL[link]}</span>
        {mode && <span className="tw-status-dim">{mode === 'ssh' ? 'pty · ssh' : 'pty · local'}</span>}
        <span className="tw-status-gap" />
        {render && (
          <span className="tw-status-dim" title="Canvas resolution in physical pixels, and canvas pixels per CSS pixel">
            {render}
          </span>
        )}
        {latency !== null && <span className="tw-status-dim">{latency} ms</span>}
        {size && <span className="tw-status-dim">{size}</span>}
      </footer>
      {copied && <span className="tw-copied">Copied</span>}
      {menu && (
        <div className="tw-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" disabled={!term.current?.hasSelection()} onClick={() => menuAction('copy')}>
            Copy <kbd>Ctrl+C</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => menuAction('paste')}>
            Paste <kbd>Ctrl+V</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => menuAction('all')}>
            Select all
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => menuAction('find')}>
            Find <kbd>Ctrl+Shift+F</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => menuAction('top')}>
            Scroll to top
          </button>
          <button type="button" role="menuitem" onClick={() => menuAction('bottom')}>
            Scroll to bottom
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => menuAction('clear')}>
            Clear scrollback
          </button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ scrolling

/** Re-renders on every scroll or buffer growth, at most once per frame. */
function useBufferPos(t: Terminal): { viewportY: number; baseY: number; rows: number } {
  const read = () => ({ viewportY: t.buffer.active.viewportY, baseY: t.buffer.active.baseY, rows: t.rows });
  const [pos, setPos] = useState(read);
  useEffect(() => {
    let frame = 0;
    const kick = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPos((p) => {
          const n = read();
          return n.viewportY === p.viewportY && n.baseY === p.baseY && n.rows === p.rows ? p : n;
        });
      });
    };
    const subs = [t.onScroll(kick), t.onWriteParsed(kick), t.onResize(kick), t.buffer.onBufferChange(kick)];
    return () => {
      cancelAnimationFrame(frame);
      for (const s of subs) s.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
  return pos;
}

interface RailProps {
  readonly term: Terminal;
  readonly marks: readonly CellRange[];
  readonly current: CellRange | null;
}

/**
 * The vertical scrollbar, drawn by us in place of xterm's. Drag the thumb, click
 * the track to jump, hover for the line number. Search hits show as ticks.
 */
function ScrollRail({ term: t, marks, current }: RailProps): JSX.Element {
  const { viewportY, baseY, rows } = useBufferPos(t);
  const track = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  const [drag, setDrag] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setH(el.clientHeight));
    obs.observe(el);
    setH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  const total = baseY + rows;
  const thumbH = Math.max(28, total > 0 ? (h * rows) / total : h);
  const room = Math.max(1, h - thumbH);
  const thumbTop = baseY > 0 ? (viewportY / baseY) * room : 0;
  const lineAt = (y: number) => Math.round(Math.min(1, Math.max(0, (y - thumbH / 2) / room)) * baseY);

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (baseY === 0 || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - box.top;
    const onThumb = y >= thumbTop && y <= thumbTop + thumbH;
    const grab = onThumb ? y - thumbTop : thumbH / 2;
    if (!onThumb) t.scrollToLine(lineAt(y));
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const top = Math.min(room, Math.max(0, ev.clientY - box.top - grab));
      t.scrollToLine(Math.round((top / room) * baseY));
    };
    const up = () => {
      setDrag(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      t.focus();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // Ticks, merged when they land on the same pixel row.
  const ticks = useMemo(() => {
    if (total <= 0 || h <= 0) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const m of marks) {
      const y = Math.round((m.row / total) * h);
      if (!seen.has(y)) {
        seen.add(y);
        out.push(y);
      }
    }
    return out;
  }, [marks, total, h]);

  const hoverLine = hover === null ? null : lineAt(hover);

  return (
    <div
      ref={track}
      className={`tw-rail${baseY === 0 ? ' is-empty' : ''}${drag ? ' is-drag' : ''}`}
      onPointerDown={onTrackDown}
      onPointerMove={(e) => setHover(e.clientY - e.currentTarget.getBoundingClientRect().top)}
      onPointerLeave={() => setHover(null)}
      onMouseDown={(e) => e.stopPropagation()}
      aria-hidden="true"
    >
      {ticks.map((y) => (
        <i key={y} className="tw-tick" style={{ top: y }} />
      ))}
      {current && total > 0 && <i className="tw-tick is-current" style={{ top: Math.round((current.row / total) * h) }} />}
      <div className="tw-thumb" style={{ top: thumbTop, height: thumbH }} />
      {hover !== null && hoverLine !== null && baseY > 0 && (
        <span className="tw-rail-tip" style={{ top: Math.min(h - 20, Math.max(0, hover - 10)) }}>
          {baseY - hoverLine === 0 ? 'live' : `−${baseY - hoverLine} lines`}
        </span>
      )}
    </div>
  );
}

/** "Back to live output", shown while scrolled up into history. */
function JumpPill({ term: t }: { readonly term: Terminal }): JSX.Element | null {
  const { viewportY, baseY } = useBufferPos(t);
  const behind = baseY - viewportY;
  if (behind <= 0) return null;
  return (
    <button
      type="button"
      className="tw-jump"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        t.scrollToBottom();
        t.focus();
      }}
    >
      ↓ {behind} {behind === 1 ? 'line' : 'lines'} below
    </button>
  );
}
