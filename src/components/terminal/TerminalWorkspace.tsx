import { type CSSProperties, type JSX, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/urls';
import { prefersReducedMotion } from '../../lib/motion';
import { useNow } from '../../hooks/useNow';
import {
  CLOSE_MS,
  COMPACT_FONT_SIZE,
  COMPACT_QUERY,
  EARLY_MAX,
  earlyKey,
  encodeKey,
  FONT_SIZE,
  formatElapsed,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  NO_MODS,
  readPrefs,
  readSnippets,
  readStoredSize,
  readWins,
  resolveScheme,
  SHORTCUTS,
  shortTitle,
  storePrefs,
  storeSize,
  storeSnippets,
  storeWins,
  useSiteTheme,
  type KeyDef,
  type Layout,
  type Mods,
  type Prefs,
  type SearchOpts,
  type Snippet,
  type Win,
} from './model';
import { Icon, KeyButton, Popover, ShortcutSheet, SnippetsPanel, ThemePanel } from './panels';
import { LINK_LABEL, TerminalView, type Port, type SearchResult, type WinStatus } from './TerminalView';
import '@xterm/xterm/css/xterm.css';
import '../../terminal.css';
import { formatClock, formatDay } from '../../shared/time';

type Panel = 'none' | 'themes' | 'snippets' | 'more' | 'tabs';

interface WorkspaceProps {
  readonly open: boolean;
  readonly onHide: () => void;
  readonly onEmpty: () => void;
}

/** Footer hints, least important first: narrow screens drop them from the left (terminal.css). */
const FOOTER_ORDER = ['Alt+W', 'Alt+1…9', 'Alt+N', 'Alt+S', 'Ctrl+Shift+F', 'Esc', 'F1'];
const FOOTER_KEYS = SHORTCUTS.flatMap((g) => g.items.filter((s) => s.footer)).sort(
  (a, b) => FOOTER_ORDER.indexOf(a.keys) - FOOTER_ORDER.indexOf(b.keys),
);

/**
 * The terminal: a full-screen sheet over the dashboard with tabs or tiles of
 * shells. Each window is a TerminalView bound to its own server shell; this
 * component owns the chrome around them (bar, panels, status, key bar).
 */
export function TerminalWorkspace({ open, onHide, onEmpty }: WorkspaceProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [wins, setWins] = useState<readonly Win[]>(readWins);
  const [active, setActive] = useState(() => wins[0]?.id ?? 1);
  const [titles, setTitles] = useState<Readonly<Record<number, string>>>({});
  const [statuses, setStatuses] = useState<Readonly<Record<number, WinStatus>>>({});
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [layout, setLayout] = useState<Layout>('tabs');
  const [full, setFull] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  const [chosenSize, setChosenSize] = useState<number | null>(readStoredSize);
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [snippets, setSnippetsState] = useState<readonly Snippet[]>(readSnippets);
  const [panel, setPanel] = useState<Panel>('none');
  const [sheet, setSheet] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [pasteAsk, setPasteAsk] = useState<{ text: string; go: () => void } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
  const [find, setFind] = useState<{ open: boolean; query: string; opts: SearchOpts; result: SearchResult }>({
    open: false,
    query: '',
    opts: { caseSensitive: false, regex: false, wholeWord: false },
    result: { index: 0, total: 0 },
  });
  const findInput = useRef<HTMLInputElement>(null);
  const modsRef = useRef<Mods>(NO_MODS);
  const ports = useRef(new Map<number, Port>());
  const broadcastRef = useRef(false);
  broadcastRef.current = broadcast && wins.length > 1;
  const siteTheme = useSiteTheme();
  // The session timer only needs minutes.
  const now = useNow(30_000);

  const fontSize = chosenSize ?? (compact ? COMPACT_FONT_SIZE : FONT_SIZE);
  const scheme = useMemo(() => resolveScheme(prefs.scheme, siteTheme), [prefs.scheme, siteTheme]);
  const status = statuses[active];

  useEffect(() => storeWins(wins), [wins]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      storePrefs(next);
      return next;
    });
  }, []);

  const setSnippets = (list: readonly Snippet[]) => {
    setSnippetsState(list);
    storeSnippets(list);
  };

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  /** Bigger or smaller text, remembered in this browser. Clicking the size resets it. */
  const resizeText = useCallback(
    (delta: number) => {
      setChosenSize((cur) => {
        const base = cur ?? (compact ? COMPACT_FONT_SIZE : FONT_SIZE);
        const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, base + delta));
        storeSize(next);
        return next;
      });
    },
    [compact],
  );

  const resetText = () => {
    setChosenSize(null);
    storeSize(null);
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
    const cur = modsRef.current[which];
    setMods({ ...modsRef.current, [which]: cur === 'off' ? 'once' : cur === 'once' ? 'lock' : 'off' });
  };

  /** Input from a window: to that shell, or to every shell while broadcasting. */
  const onInput = useCallback((id: number, data: string) => {
    if (broadcastRef.current) for (const p of ports.current.values()) p.send(data);
    else ports.current.get(id)?.send(data);
  }, []);

  const press = (key: KeyDef) => {
    onInput(active, encodeKey(key, modsRef.current));
    modsUsed();
  };

  const focusActive = useCallback(() => ports.current.get(active)?.focus(), [active]);

  const pasteFromClipboard = () => {
    void navigator.clipboard
      .readText()
      .then((text) => ports.current.get(active)?.paste(text))
      .catch(() => flash('Clipboard not available'));
  };

  const useSnippet = (command: string, run: boolean) => {
    setPanel('none');
    onInput(active, run ? `${command}\r` : command);
    focusActive();
  };

  const confirmPaste = useCallback((text: string, go: () => void) => setPasteAsk({ text, go }), []);

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
        storeWins(null);
        onEmpty();
        return;
      }
      setWins(rest);
      setStatuses((s) => {
        const { [id]: _gone, ...keep } = s;
        return keep;
      });
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

  const onStatus = useCallback((id: number, s: WinStatus) => {
    setStatuses((all) => (all[id] === s ? all : { ...all, [id]: s }));
  }, []);

  const onActivity = useCallback((id: number) => {
    setBusy((b) => (b.has(id) ? b : new Set(b).add(id)));
  }, []);

  const onCopied = useCallback(() => flash('Copied'), [flash]);

  const rename = (id: number, name: string) => {
    const clean = name.trim().slice(0, 40);
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, name: clean || undefined } : w)));
    setRenaming(null);
  };

  const tabLabel = (w: Win): string => w.name || shortTitle(titles[w.id] ?? '') || `Shell ${w.id}`;
  const activeWin = wins.find((w) => w.id === active);

  // ---- output: copy or save everything in the active window

  const copyAll = () => {
    setPanel('none');
    const text = ports.current.get(active)?.text() ?? '';
    void copyToClipboard(text).then((ok) => flash(ok ? 'Output copied' : 'Copy failed'));
  };

  const saveAll = () => {
    setPanel('none');
    const text = ports.current.get(active)?.text() ?? '';
    const now = Date.now();
    const stamp = `${formatDay(now)}-${formatClock(now).replace(/:/g, '')}`;
    const name = (activeWin ? tabLabel(activeWin) : 'shell').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'shell';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulse-${name}-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('Saved');
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
    setPanel('none');
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
    setPanel('none');
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const hide = useCallback(() => {
    setPanel('none');
    setSheet(false);
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
  // (where "/", "[" and 1-5 are shortcuts). The active shell pulls focus to
  // itself as soon as its xterm is ready; until then keys are queued (early).
  // Layout effect: focus moves before the first paint, so no key slips past.
  useLayoutEffect(() => {
    if (!open) return;
    early.current = '';
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [open]);

  // Closing a panel hands focus back to the shell, or keys would land nowhere
  // (the panel's own input is gone) and the next shortcut would be lost.
  const closePanel = useCallback(() => {
    setPanel('none');
    requestAnimationFrame(() => {
      const el = root.current;
      if (el && (!el.contains(document.activeElement) || document.activeElement === el)) focusActive();
    });
  }, [focusActive]);

  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? 'none' : p));

  const cols = Math.ceil(Math.sqrt(wins.length));
  const tiled = layout === 'tile' && !compact && wins.length > 1;
  const live = status?.link === 'live';
  const broadcasting = broadcast && wins.length > 1;

  const rootStyle = {
    '--term-bg': scheme.background,
    '--term-fg': scheme.foreground,
    '--term-accent': scheme.cursor,
    '--term-sel': scheme.selection,
  } as CSSProperties;

  const toolButton = (key: string, label: string, title: string, icon: JSX.Element, onClick: () => void, on = false, pop?: string) => (
    <button
      key={key}
      type="button"
      className={`tw-tool${on ? ' is-on' : ''}`}
      aria-label={label}
      aria-pressed={pop ? undefined : on}
      aria-expanded={pop ? on : undefined}
      data-pop={pop}
      title={title}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <div
      ref={root}
      className={`tw${open ? '' : ' is-hidden'}${closing ? ' is-closing' : ''}${compact ? ' is-compact' : ''}${scheme.dark ? ' is-term-dark' : ' is-term-light'}${broadcasting ? ' is-broadcast' : ''}`}
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
        // Escape first closes the workspace's own layers. Then, at the normal screen, it goes
        // back to the dashboard. In a full-screen program (vim, less) it belongs to the program,
        // and TerminalView lets it through to the shell instead.
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (sheet) setSheet(false);
          else if (panel !== 'none') setPanel('none');
          else if (pasteAsk) setPasteAsk(null);
          else if (!e.shiftKey && !ports.current.get(active)?.altScreen()) {
            e.preventDefault();
            hide();
            return;
          } else return;
          e.preventDefault();
          focusActive();
          return;
        }
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
          e.preventDefault();
          hide();
          return;
        }
        if (e.key === 'F1') {
          e.preventDefault();
          setSheet((s) => !s);
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
        else if (key === 's') togglePanel('snippets');
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
        else if (/^[1-9]$/.test(e.key)) {
          const w = wins[Number(e.key) - 1];
          if (w) activate(w.id);
        } else return;
        e.preventDefault();
      }}
    >
      <header className="tw-bar">
        {!compact && (
          <div className="tw-brand" aria-hidden="true">
            <span className="tw-brand-mark">&gt;_</span>
            <span>Terminal</span>
          </div>
        )}

        {compact ? (
          <div className="tw-pop-wrap tw-switch-wrap">
            <button
              type="button"
              className={`tw-switch${panel === 'tabs' ? ' is-on' : ''}`}
              data-pop="tabs"
              aria-expanded={panel === 'tabs'}
              aria-label={`Windows: ${activeWin ? tabLabel(activeWin) : ''}, ${wins.length} open`}
              onClick={() => togglePanel('tabs')}
            >
              <span className={`tw-led is-${status?.link ?? 'connecting'}`} aria-hidden="true" />
              <span className="tw-switch-label">{activeWin ? tabLabel(activeWin) : 'Shell'}</span>
              {wins.length > 1 && <span className="tw-count">{wins.length}</span>}
              <Icon.down size={14} />
            </button>
            {panel === 'tabs' && (
              <Popover id="tabs" label="Windows" onClose={closePanel} className="tw-pop-tabs">
                <ul className="tw-winlist">
                  {wins.map((w) => (
                    <li key={w.id} className={w.id === active ? 'is-active' : ''}>
                      <button
                        type="button"
                        className="tw-winlist-main"
                        onClick={() => {
                          activate(w.id);
                          setPanel('none');
                        }}
                      >
                        <span className={`tw-led is-${statuses[w.id]?.link ?? 'connecting'}`} aria-hidden="true" />
                        <span>{tabLabel(w)}</span>
                        {busy.has(w.id) && <span className="tw-busy-dot" aria-label="new output" />}
                      </button>
                      <button type="button" className="tw-icon-btn is-sm" aria-label={`Close ${tabLabel(w)}`} onClick={() => close(w.id)}>
                        <Icon.close />
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-sm tw-winlist-add"
                  onClick={() => {
                    add();
                    setPanel('none');
                  }}
                >
                  <Icon.plus size={14} /> New window
                </button>
              </Popover>
            )}
          </div>
        ) : (
          <div className="tw-tabs" role="tablist" aria-label="Windows">
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
                    onAuxClick={(e) => e.button === 1 && close(w.id)}
                  >
                    <span className={`tw-led is-${statuses[w.id]?.link ?? 'connecting'}`} aria-hidden="true" />
                    <span className="tw-tab-text">{tabLabel(w)}</span>
                    {i < 9 && <kbd className="tw-tab-kbd">{i + 1}</kbd>}
                  </button>
                )}
                <button type="button" className="tw-tab-x" aria-label={`Close ${tabLabel(w)}`} title="Close (Alt+W)" onClick={() => close(w.id)}>
                  <Icon.close size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="tw-tab-add" onClick={add} aria-label="New window" title="New window (Alt+N)">
              <Icon.plus size={14} />
            </button>
          </div>
        )}

        <div className="tw-tools">
          {compact &&
            toolButton('add', 'New window', 'New window', <Icon.plus />, add)}
          {toolButton('find', 'Find', 'Find in scrollback (Ctrl+Shift+F)', <Icon.search />, find.open ? closeFind : openFind, find.open)}
          <div className="tw-pop-wrap">
            {toolButton('snip', 'Snippets', 'Snippets (Alt+S)', <Icon.bolt />, () => togglePanel('snippets'), panel === 'snippets', 'snippets')}
            {panel === 'snippets' && <SnippetsPanel list={snippets} onChange={setSnippets} onUse={useSnippet} onClose={closePanel} />}
          </div>
          {!compact && wins.length > 1 &&
            toolButton(
              'layout',
              layout === 'tabs' ? 'Show side by side' : 'Show one at a time',
              layout === 'tabs' ? 'Show all windows side by side' : 'Show one window at a time',
              layout === 'tabs' ? <Icon.tile /> : <Icon.tabs />,
              () => setLayout((l) => (l === 'tabs' ? 'tile' : 'tabs')),
              layout === 'tile',
            )}
          {!compact && wins.length > 1 &&
            toolButton('broadcast', 'Type into every window', broadcast ? 'Broadcasting: typing goes to every window' : 'Type into every window at once', <Icon.broadcast />, () => setBroadcast((b) => !b), broadcast)}
          {!compact && (
            <div className="tw-size" role="group" aria-label="Text size">
              <button type="button" className="tw-size-btn" onClick={() => resizeText(-1)} disabled={fontSize <= MIN_FONT_SIZE} aria-label="Smaller text" title="Smaller text (Ctrl+wheel)">
                A−
              </button>
              <button type="button" className="tw-size-now" onClick={resetText} title="Reset text size">
                {fontSize}
              </button>
              <button type="button" className="tw-size-btn" onClick={() => resizeText(1)} disabled={fontSize >= MAX_FONT_SIZE} aria-label="Bigger text" title="Bigger text (Ctrl+wheel)">
                A+
              </button>
            </div>
          )}
          <div className="tw-pop-wrap">
            {toolButton('theme', 'Appearance', 'Appearance and behaviour', <Icon.palette />, () => togglePanel('themes'), panel === 'themes', 'theme')}
            {panel === 'themes' && <ThemePanel prefs={prefs} siteTheme={siteTheme} onChange={setPrefs} onClose={closePanel} />}
          </div>
          <div className="tw-pop-wrap">
            {toolButton('more', 'More', 'More', <Icon.more />, () => togglePanel('more'), panel === 'more', 'more')}
            {panel === 'more' && (
              <Popover id="more" label="More" onClose={closePanel} className="tw-pop-menu">
                <div className="tw-menu-list" role="menu">
                  <button type="button" role="menuitem" onClick={copyAll}>
                    <Icon.copy /> Copy all output
                  </button>
                  <button type="button" role="menuitem" onClick={saveAll}>
                    <Icon.download /> Save output as .txt
                  </button>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPanel('none');
                      ports.current.get(active)?.clear();
                      focusActive();
                    }}
                  >
                    <Icon.eraser /> Clear screen and scrollback
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPanel('none');
                      ports.current.get(active)?.restart();
                      focusActive();
                    }}
                  >
                    <Icon.restart /> Restart shell
                  </button>
                  {compact && (
                    <>
                      <hr />
                      <div className="tw-menu-row">
                        <span>Text size</span>
                        <span className="tw-size">
                          <button type="button" className="tw-size-btn" onClick={() => resizeText(-1)} disabled={fontSize <= MIN_FONT_SIZE} aria-label="Smaller text">
                            A−
                          </button>
                          <button type="button" className="tw-size-now" onClick={resetText}>
                            {fontSize}
                          </button>
                          <button type="button" className="tw-size-btn" onClick={() => resizeText(1)} disabled={fontSize >= MAX_FONT_SIZE} aria-label="Bigger text">
                            A+
                          </button>
                        </span>
                      </div>
                      {wins.length > 1 && (
                        <button type="button" role="menuitemcheckbox" aria-checked={broadcast} onClick={() => setBroadcast((b) => !b)}>
                          <Icon.broadcast /> Type into every window {broadcast ? '· on' : ''}
                        </button>
                      )}
                    </>
                  )}
                  {!compact && (
                    <>
                      <hr />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setPanel('none');
                          setSheet(true);
                        }}
                      >
                        <Icon.keyboard /> Keyboard shortcuts <kbd>F1</kbd>
                      </button>
                    </>
                  )}
                  {document.fullscreenEnabled && (
                    <button type="button" role="menuitem" onClick={toggleFullscreen}>
                      {full ? <Icon.shrink /> : <Icon.expand />} {full ? 'Exit fullscreen' : 'Fullscreen'}
                    </button>
                  )}
                </div>
              </Popover>
            )}
          </div>
          <button type="button" className="tw-hide" onClick={hide} title="Back to dashboard (Esc or Ctrl+`). Shells keep running." aria-label="Hide terminal">
            <Icon.down />
            {!compact && <span>Hide</span>}
          </button>
        </div>
      </header>

      {find.open && (
        <div className="tw-find" role="search">
          <Icon.search size={14} />
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
            {find.query ? (find.result.total ? `${find.result.index + 1} of ${find.result.total}` : 'No results') : ''}
          </span>
          {(
            [
              ['caseSensitive', 'Aa', 'Match case'],
              ['wholeWord', 'ab', 'Whole word'],
              ['regex', '.*', 'Regular expression'],
            ] as const
          ).map(([k, label, name]) => (
            <button
              key={k}
              type="button"
              className={`tw-chip${find.opts[k] ? ' is-on' : ''}`}
              aria-pressed={find.opts[k]}
              title={name}
              aria-label={name}
              onClick={() => runFind(find.query, { ...find.opts, [k]: !find.opts[k] }, 0)}
            >
              {label}
            </button>
          ))}
          <button type="button" className="tw-chip" title="Previous (Shift+Enter)" aria-label="Previous match" onClick={() => runFind(find.query, find.opts, -1)}>
            ↑
          </button>
          <button type="button" className="tw-chip" title="Next (Enter)" aria-label="Next match" onClick={() => runFind(find.query, find.opts, 1)}>
            ↓
          </button>
          <button type="button" className="tw-chip" aria-label="Close find" onClick={closeFind}>
            <Icon.close size={12} />
          </button>
        </div>
      )}

      {pasteAsk && (
        <div className="tw-ask" role="alertdialog" aria-label="Confirm paste">
          <span>
            <strong>Paste {pasteAsk.text.split(/\r?\n/).filter((l) => l.length).length} lines?</strong> Each line runs as a command as soon as it lands.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            autoFocus
            onClick={() => {
              pasteAsk.go();
              setPasteAsk(null);
              focusActive();
            }}
          >
            Paste
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setPasteAsk(null);
              focusActive();
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {broadcasting && (
        <div className="tw-ask is-broadcast" role="status">
          <Icon.broadcast size={14} />
          <span>
            <strong>Broadcasting.</strong> Everything typed goes to all {wins.length} windows.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setBroadcast(false)}>
            Stop
          </button>
        </div>
      )}

      <div className={`tw-body${tiled ? ' is-tile' : ''}`} style={tiled ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
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
            shown={tiled || w.id === active}
            focused={open && w.id === active}
            current={w.id === active}
            tiled={tiled}
            onFocus={() => activate(w.id)}
            onClose={() => close(w.id)}
            onSid={onSid}
            onTitle={onTitle}
            onActivity={onActivity}
            onStatus={onStatus}
            onZoom={resizeText}
            onFind={openFind}
            onInput={onInput}
            onConfirmPaste={confirmPaste}
            onCopied={onCopied}
            takeEarly={takeEarly}
          />
        ))}
      </div>

      <footer className="tw-foot">
        <span className={`tw-led is-${status?.link ?? 'connecting'}`} aria-hidden="true" />
        <span className="tw-foot-strong">{LINK_LABEL[status?.link ?? 'connecting']}</span>
        {status?.mode && <span>{status.mode === 'ssh' ? 'ssh' : 'local'}</span>}
        {!compact && status?.pid != null && <span>pid {status.pid}</span>}
        {live && status?.since != null && <span title="Attached for">{formatElapsed(Math.max(0, now - status.since))}</span>}
        {status?.latency != null && <span>{status.latency} ms</span>}
        {status?.size && <span>{status.size}</span>}
        {!compact && status?.renderer && <span title={status.renderer === 'GPU' ? 'WebGL renderer' : 'DOM renderer (no WebGL)'}>{status.renderer}</span>}
        <span className="tw-foot-gap" />
        {!compact && (
          <span className="tw-foot-keys" aria-label="Keyboard shortcuts">
            {FOOTER_KEYS.map((s) => (
              <span key={s.keys}>
                <kbd>{s.keys}</kbd> {s.keys === 'F1' ? 'all shortcuts' : s.does.replace(/ \(.*\)$/, '').toLowerCase()}
              </span>
            ))}
          </span>
        )}
      </footer>

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
          <KeyButton label="^C" name="Control C, interrupt" onPress={() => onInput(active, '\x03')} />
          <KeyButton label="^D" name="Control D, end of input" onPress={() => onInput(active, '\x04')} />
          <KeyButton label="^L" name="Control L, clear" onPress={() => onInput(active, '\x0c')} />
          <KeyButton label="^R" name="Control R, history search" onPress={() => onInput(active, '\x12')} />
          {['/', '-', '|', '~', '`', '\\', '_', '$', '*', '&'].map((ch) => (
            <KeyButton key={ch} label={ch} onPress={() => press({ k: 'text', value: ch })} />
          ))}
          <KeyButton label="Home" onPress={() => press({ k: 'csi', final: 'H' })} />
          <KeyButton label="End" onPress={() => press({ k: 'csi', final: 'F' })} />
          <KeyButton label="PgUp" onPress={() => press({ k: 'tilde', n: 5 })} />
          <KeyButton label="PgDn" onPress={() => press({ k: 'tilde', n: 6 })} />
          {typeof navigator.clipboard?.readText === 'function' && <KeyButton label="Paste" wide onPress={pasteFromClipboard} />}
        </div>
      )}

      {sheet && (
        <ShortcutSheet
          onClose={() => {
            setSheet(false);
            focusActive();
          }}
        />
      )}
      {toast && (
        <span className="tw-toast" role="status">
          {toast}
        </span>
      )}
    </div>
  );
}
