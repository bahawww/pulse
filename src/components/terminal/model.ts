import { useEffect, useState } from 'react';
import type { ITheme, Terminal } from '@xterm/xterm';
import { SCHEMES, SCHEME_IDS, SITE_SCHEME, type TermScheme } from '../../lib/termThemes';
import { parseTree, type Node } from './split';

// ------------------------------------------------------------------ windows and prefs

export interface Win {
  readonly id: number;
  /** Name the person gave the tab. Wins over the shell's own title. */
  readonly name?: string;
  /** Server shell id, so a reload or dropped connection reattaches the same shell. */
  readonly sid?: string;
  /** A remote host (router, switch, server) instead of a shell on this machine. */
  readonly target?: Target;
}

/** Tabs: one window at a time. Split: every window on screen, arranged by a tree. */
export type Mode = 'tabs' | 'split';
export type CursorStyle = 'bar' | 'block' | 'underline';

export interface Prefs {
  readonly scheme: string;
  readonly cursorStyle: CursorStyle;
  readonly blink: boolean;
  readonly lineHeight: number;
  readonly weight: 400 | 500;
  readonly boldBright: boolean;
  /** Lines of history kept per window. */
  readonly scrollback: number;
  /** Copy a selection to the clipboard as soon as the mouse lets go. */
  readonly copyOnSelect: boolean;
  /** Ask before pasting several lines into a shell that would run them one by one. */
  readonly confirmPaste: boolean;
}

export const SCROLLBACK_CHOICES = [1000, 10_000, 50_000] as const;

export const DEFAULT_PREFS: Prefs = {
  scheme: SITE_SCHEME,
  cursorStyle: 'bar',
  blink: true,
  // ASCII art (neofetch, figlet) and box drawing read as one picture at tighter spacing.
  lineHeight: 1.2,
  weight: 400,
  boldBright: false,
  scrollback: 10_000,
  copyOnSelect: true,
  confirmPaste: true,
};

export const FONT_SIZE = 14;
export const COMPACT_FONT_SIZE = 12;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;
export const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Phones and tablets get the key bar, one compact top bar and a smaller font. */
export const COMPACT_QUERY = '(max-width: 820px), (pointer: coarse)';
/** Upper bound for keys held before a shell is ready to take them. */
export const EARLY_MAX = 4096;
/** Matches the tw-out animation in terminal.css. */
export const CLOSE_MS = 220;

const SIZE_KEY = 'vps_term_font';
const PREFS_KEY = 'vps_term_prefs';
const SNIPPETS_KEY = 'vps_term_snippets';
/** Per browser tab, so a reload reattaches this tab's shells and no other's. */
const WINS_KEY = 'vps_term_wins';
/** Per browser tab too: tabs or split, the split tree and the zoomed window. */
const VIEW_KEY = 'vps_term_view';
/** Saved remote connections. Never a password: those are typed into the session. */
const CONNS_KEY = 'vps_term_conns';

export function store(key: string, value: string | null, session = false): void {
  try {
    const s = session ? sessionStorage : localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function readStoredSize(): number | null {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (Number.isInteger(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
  } catch {
    /* private mode */
  }
  return null;
}

export function storeSize(n: number | null): void {
  store(SIZE_KEY, n === null ? null : String(n));
}

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      scheme: typeof raw.scheme === 'string' && SCHEME_IDS.has(raw.scheme) ? raw.scheme : DEFAULT_PREFS.scheme,
      cursorStyle: raw.cursorStyle === 'block' || raw.cursorStyle === 'underline' ? raw.cursorStyle : 'bar',
      blink: raw.blink !== false,
      lineHeight: typeof raw.lineHeight === 'number' && raw.lineHeight >= 1 && raw.lineHeight <= 1.8 ? raw.lineHeight : DEFAULT_PREFS.lineHeight,
      weight: raw.weight === 500 ? 500 : 400,
      boldBright: raw.boldBright === true,
      scrollback: SCROLLBACK_CHOICES.includes(raw.scrollback as (typeof SCROLLBACK_CHOICES)[number]) ? (raw.scrollback as number) : DEFAULT_PREFS.scrollback,
      copyOnSelect: raw.copyOnSelect !== false,
      confirmPaste: raw.confirmPaste !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function storePrefs(p: Prefs): void {
  store(PREFS_KEY, JSON.stringify(p));
}

export function readWins(): readonly Win[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(WINS_KEY) ?? '[]') as Win[];
    const ok = Array.isArray(raw)
      ? raw
          .filter((w) => Number.isInteger(w?.id) && w.id > 0)
          .map((w) => ({
            id: w.id,
            name: typeof w.name === 'string' ? w.name : undefined,
            sid: typeof w.sid === 'string' ? w.sid : undefined,
            target: checkTarget(w.target) ?? undefined,
          }))
      : [];
    if (ok.length > 0) return ok;
  } catch {
    /* private mode */
  }
  return [{ id: 1 }];
}

export function storeWins(wins: readonly Win[] | null): void {
  store(WINS_KEY, wins === null ? null : JSON.stringify(wins), true);
}

export interface ViewState {
  readonly mode: Mode;
  readonly tree: Node | null;
  readonly zoom: boolean;
}

export function readView(): ViewState {
  try {
    const raw = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '{}') as Partial<Record<keyof ViewState, unknown>>;
    return { mode: raw.mode === 'split' ? 'split' : 'tabs', tree: parseTree(raw.tree), zoom: raw.zoom === true };
  } catch {
    return { mode: 'tabs', tree: null, zoom: false };
  }
}

export function storeView(v: ViewState | null): void {
  store(VIEW_KEY, v === null ? null : JSON.stringify(v), true);
}

// ------------------------------------------------------------------ remote targets

export type Proto = 'ssh' | 'telnet';

export interface Target {
  readonly proto: Proto;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Old key exchange, host key and cipher algorithms, for routers that never got updates. */
  readonly legacy: boolean;
}

/** A saved connection: a target plus a name and when it was last opened. */
export interface Conn extends Target {
  readonly id: string;
  readonly name: string;
  readonly used: number;
}

export const DEFAULT_PORT: Record<Proto, number> = { ssh: 22, telnet: 23 };

// Same patterns as the server (src/server/terminal.ts); it checks again.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)*\.?|[0-9A-Fa-f:.]{2,45})$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@+-]{0,63}$/;

export const validHost = (h: string): boolean => h.length <= 253 && HOST_RE.test(h);
export const validUser = (u: string): boolean => u === '' || USER_RE.test(u);

export function checkTarget(v: unknown): Target | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const proto = o.proto === 'telnet' ? 'telnet' : o.proto === 'ssh' ? 'ssh' : null;
  const host = typeof o.host === 'string' ? o.host.trim() : '';
  const user = typeof o.user === 'string' ? o.user.trim() : '';
  const port = Number(o.port);
  if (!proto || !validHost(host) || !validUser(user) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { proto, host, port, user, legacy: o.legacy === true };
}

/**
 * What a person types into quick connect: `admin@192.168.88.1`, `ssh -p 2222 root@sw1`,
 * `telnet 10.0.0.1 2323`, `ssh://admin@router:22`, `router:8022`. SSH unless it says telnet.
 */
export function parseQuick(input: string): Target | null {
  let s = input.trim();
  if (!s) return null;
  let proto: Proto = 'ssh';
  const scheme = /^(ssh|telnet):\/\//i.exec(s);
  if (scheme) {
    proto = (scheme[1] ?? 'ssh').toLowerCase() as Proto;
    s = s.slice(scheme[0].length).replace(/\/+$/, '');
  } else {
    const word = /^(ssh|telnet)\s+/i.exec(s);
    if (word) {
      proto = (word[1] ?? 'ssh').toLowerCase() as Proto;
      s = s.slice(word[0].length);
    }
  }
  let port: number | null = null;
  let user = '';
  const flagPort = /(?:^|\s)-p\s*(\d{1,5})(?=\s|$)/.exec(s);
  if (flagPort) {
    port = Number(flagPort[1]);
    s = s.replace(flagPort[0], ' ');
  }
  const flagUser = /(?:^|\s)-l\s*(\S+)(?=\s|$)/.exec(s);
  if (flagUser) {
    user = flagUser[1] ?? '';
    s = s.replace(flagUser[0], ' ');
  }
  const parts = s.trim().split(/\s+/);
  let host = parts[0] ?? '';
  if (parts[1] && /^\d{1,5}$/.test(parts[1])) port = Number(parts[1]);
  else if (parts.length > 1) return null;
  const at = host.lastIndexOf('@');
  if (at > 0) {
    user = host.slice(0, at);
    host = host.slice(at + 1);
  }
  // [v6]:port, or host:port (one colon only, so a bare IPv6 address stays whole).
  const bracket = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
  if (bracket) {
    host = bracket[1] ?? '';
    if (bracket[2]) port = Number(bracket[2]);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    const [h, p] = host.split(':');
    if (!p || !/^\d{1,5}$/.test(p)) return null;
    host = h ?? '';
    port = Number(p);
  }
  return checkTarget({ proto, host, port: port ?? DEFAULT_PORT[proto], user, legacy: false });
}

/** `admin@router`, plus the port when it is not the protocol's usual one. */
export function targetLabel(t: Target): string {
  const port = t.port === DEFAULT_PORT[t.proto] ? '' : `:${t.port}`;
  return `${t.user ? `${t.user}@` : ''}${t.host}${port}`;
}

export const sameTarget = (a: Target, b: Target): boolean =>
  a.proto === b.proto && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.user === b.user;

export function readConns(): readonly Conn[] {
  try {
    const list = JSON.parse(localStorage.getItem(CONNS_KEY) ?? '[]') as unknown[];
    if (!Array.isArray(list)) return [];
    return list.flatMap((v) => {
      const t = checkTarget(v);
      if (!t) return [];
      const o = v as Record<string, unknown>;
      return [{ ...t, id: typeof o.id === 'string' ? o.id : newId(), name: typeof o.name === 'string' ? o.name.slice(0, 40) : '', used: typeof o.used === 'number' ? o.used : 0 }];
    });
  } catch {
    return [];
  }
}

export function storeConns(list: readonly Conn[]): void {
  store(CONNS_KEY, JSON.stringify(list));
}

/** Records a connection as just used: updates the saved one, or saves it (the newest 30 are kept). */
export function touchConn(list: readonly Conn[], t: Target, name = ''): readonly Conn[] {
  const now = Date.now();
  const found = list.find((c) => sameTarget(c, t));
  const next = found ? list.map((c) => (c === found ? { ...c, legacy: t.legacy, used: now } : c)) : [...list, { ...t, id: newId(), name, used: now }];
  return [...next].sort((a, b) => b.used - a.used).slice(0, 30);
}

// ------------------------------------------------------------------ snippets

export interface Snippet {
  readonly id: string;
  readonly label: string;
  readonly command: string;
}

const DEFAULT_SNIPPETS: readonly Snippet[] = [
  { id: 'top', label: 'Processes', command: 'htop || top' },
  { id: 'disk', label: 'Disk usage', command: 'df -h -x tmpfs -x devtmpfs' },
  { id: 'mem', label: 'Memory', command: 'free -h' },
  { id: 'docker', label: 'Containers', command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'" },
  { id: 'ports', label: 'Listening ports', command: 'ss -ltnp' },
  { id: 'failed', label: 'Failed units', command: 'systemctl --failed' },
  { id: 'journal', label: 'Follow journal', command: 'journalctl -f -n 50' },
];

export function readSnippets(): readonly Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (raw === null) return DEFAULT_SNIPPETS;
    const list = JSON.parse(raw) as Snippet[];
    if (!Array.isArray(list)) return DEFAULT_SNIPPETS;
    return list
      .filter((s) => typeof s?.command === 'string' && s.command.trim() !== '')
      .map((s) => ({ id: typeof s.id === 'string' ? s.id : newId(), label: typeof s.label === 'string' ? s.label : '', command: s.command }));
  } catch {
    return DEFAULT_SNIPPETS;
  }
}

export function storeSnippets(list: readonly Snippet[]): void {
  store(SNIPPETS_KEY, JSON.stringify(list));
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------------ shortcuts

export interface Shortcut {
  readonly keys: string;
  readonly does: string;
  /** Shown in the desktop footer, not only in the full list. */
  readonly footer?: boolean;
  /** The footer's one or two words for it. */
  readonly short?: string;
}

/** One list for the footer hints, the shortcut sheet and the command palette. */
export const SHORTCUTS: readonly { readonly group: string; readonly items: readonly Shortcut[] }[] = [
  {
    group: 'Windows',
    items: [
      { keys: 'Alt+N', does: 'New window', footer: true, short: 'new' },
      { keys: 'Alt+W', does: 'Close window', footer: true, short: 'close' },
      { keys: 'Alt+1…9', does: 'Go to window' },
      { keys: 'Alt+0', does: 'Back to the last window' },
      { keys: 'Alt+← / Alt+→', does: 'Previous / next window (tabs)' },
      { keys: 'Alt+Shift+← / →', does: 'Move the tab left / right (tabs)' },
      { keys: 'Alt+R', does: 'Rename window' },
      { keys: 'Esc', does: 'Back to dashboard (shells keep running)', footer: true, short: 'dashboard' },
      { keys: 'Ctrl+`', does: 'Back to dashboard, also inside vim or less' },
    ],
  },
  {
    group: 'Split view',
    items: [
      { keys: 'Alt+Enter', does: 'Split view on / off: every window on screen', footer: true, short: 'split view' },
      { keys: 'Alt+\\', does: 'Split right: new window beside this one', footer: true, short: 'split' },
      { keys: 'Alt+-', does: 'Split down: new window below this one' },
      { keys: 'Alt+Arrows', does: 'Move to the window on that side' },
      { keys: 'Alt+Shift+Arrows', does: 'Move the divider' },
      { keys: 'Alt+Z', does: 'Zoom: this window alone, again to go back' },
      { keys: 'Alt+G', does: 'Next layout: grid, columns, rows, main and stack' },
      { keys: 'Alt+X', does: 'Swap with the next window' },
      { keys: 'Ctrl+Shift+B', does: 'Type into every window at once' },
    ],
  },
  {
    group: 'Tools',
    items: [
      { keys: 'Ctrl+Shift+P', does: 'Command palette: every action, window and connection', footer: true, short: 'commands' },
      { keys: 'Alt+O', does: 'Connect to a router or server (SSH, Telnet)', footer: true, short: 'connect' },
      { keys: 'Ctrl+Shift+F', does: 'Find in scrollback' },
      { keys: 'Alt+S', does: 'Snippets' },
      { keys: 'Ctrl+= / Ctrl+- / Ctrl+0', does: 'Text size, reset' },
      { keys: 'Ctrl+wheel', does: 'Text size' },
      { keys: 'F1', does: 'This list', footer: true, short: 'all shortcuts' },
    ],
  },
  {
    group: 'Editing',
    items: [
      { keys: 'Ctrl+C', does: 'Copy when text is selected, otherwise interrupt' },
      { keys: 'Ctrl+V', does: 'Paste' },
      { keys: 'Ctrl+A', does: 'Select the command being typed' },
      { keys: 'Alt+A', does: 'Start of line (the shell’s own Ctrl+A)' },
      { keys: 'Ctrl+Backspace', does: 'Delete word' },
      { keys: 'Ctrl+[', does: 'Send Esc to the shell (Esc itself goes to the program inside vim, less, htop)' },
      { keys: 'Shift+right click', does: 'Browser menu instead of the terminal menu' },
    ],
  },
];

/** Everything the workspace does from the keyboard. */
export type Action =
  | 'new' | 'close' | 'rename' | 'prev' | 'next' | 'last' | 'moveLeft' | 'moveRight'
  | 'toggleSplit' | 'splitRight' | 'splitDown' | 'zoom' | 'layout' | 'swap' | 'broadcast'
  | 'focusLeft' | 'focusRight' | 'focusUp' | 'focusDown'
  | 'growLeft' | 'growRight' | 'growUp' | 'growDown'
  | 'palette' | 'connect' | 'find' | 'snippets' | 'sheet' | 'hide'
  | 'textUp' | 'textDown' | 'textReset'
  | `goto${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

const ARROW: Record<string, 'Left' | 'Right' | 'Up' | 'Down'> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };

/**
 * The workspace action for a key press, or null when the key belongs to the shell.
 * One function for both sides: the workspace runs the action and xterm drops the key.
 * Keys are read by `code`, so they work on any keyboard layout and with macOS Option.
 * Alt letters that readline uses (B, F, D, T, U, L, C, Y, P, dot) are left alone.
 */
export function keyAction(e: KeyboardEvent, split: boolean): Action | null {
  if (e.metaKey) return null;
  const { altKey: alt, ctrlKey: ctrl, shiftKey: shift, code } = e;
  if (e.key === 'F1' && !alt && !ctrl) return 'sheet';
  if (ctrl && !alt && code === 'Backquote') return 'hide';
  if (ctrl && shift && !alt) {
    if (code === 'KeyP') return 'palette';
    if (code === 'KeyF') return 'find';
    if (code === 'KeyB') return 'broadcast';
    return null;
  }
  if (ctrl && !shift && !alt) {
    if (code === 'Equal' || code === 'NumpadAdd') return 'textUp';
    if (code === 'Minus' || code === 'NumpadSubtract') return 'textDown';
    if (code === 'Digit0' || code === 'Numpad0') return 'textReset';
    return null;
  }
  if (!alt || ctrl) return null;
  const arrow = ARROW[code];
  if (arrow) {
    if (shift) {
      if (split) return `grow${arrow}`;
      return arrow === 'Left' ? 'moveLeft' : arrow === 'Right' ? 'moveRight' : null;
    }
    if (split) return `focus${arrow}`;
    return arrow === 'Left' ? 'prev' : arrow === 'Right' ? 'next' : null;
  }
  if (shift) return null;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return digit === '0' ? 'last' : (`goto${digit}` as Action);
  switch (code) {
    case 'KeyN':
      return 'new';
    case 'KeyW':
      return 'close';
    case 'KeyR':
      return 'rename';
    case 'KeyS':
      return 'snippets';
    case 'KeyO':
      return 'connect';
    case 'KeyZ':
      return 'zoom';
    case 'KeyG':
      return 'layout';
    case 'KeyX':
      return 'swap';
    case 'Enter':
    case 'NumpadEnter':
      return 'toggleSplit';
    case 'Backslash':
    case 'IntlBackslash':
      return 'splitRight';
    case 'Minus':
    case 'NumpadSubtract':
      return 'splitDown';
    default:
      return null;
  }
}

// ------------------------------------------------------------------ touch key bar

/** Sticky modifier from the touch key bar: off, armed for one key, or locked. */
export type ModState = 'off' | 'once' | 'lock';

export interface Mods {
  readonly ctrl: ModState;
  readonly alt: ModState;
}

export const NO_MODS: Mods = { ctrl: 'off', alt: 'off' };

export type KeyDef =
  | { readonly k: 'esc' }
  | { readonly k: 'tab' }
  | { readonly k: 'csi'; readonly final: string }
  | { readonly k: 'tilde'; readonly n: number }
  | { readonly k: 'text'; readonly value: string };

/** Ctrl and Alt applied to one character typed on a soft keyboard. */
export function applyMods(data: string, mods: Mods): string {
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
export function encodeKey(key: KeyDef, mods: Mods): string {
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

/** What a key press sends to a shell, for keys queued before xterm has focus. */
export function earlyKey(key: string): string | null {
  if (key.length === 1) return key;
  if (key === 'Enter') return '\r';
  if (key === 'Backspace') return '\x7f';
  if (key === 'Tab') return '\t';
  return null;
}

// ------------------------------------------------------------------ titles

/** The shell's own title ("user@host: ~/dir") shortened to the directory part. */
export function shortTitle(title: string): string {
  return title.replace(/^[^@\s]+@[^:\s]+:\s*/, '').trim();
}

// ------------------------------------------------------------------ colour schemes

/** ANSI colours drawn from the dashboard palette, for the `site` scheme. */
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

export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1] ?? '0', 16)}, ${parseInt(m[2] ?? '0', 16)}, ${parseInt(m[3] ?? '0', 16)}, ${alpha})`;
}

/** The site's light/dark choice, kept current as the person toggles it. */
export function useSiteTheme(): 'dark' | 'light' {
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
export function resolveScheme(id: string, site: 'dark' | 'light'): TermScheme {
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

export function xtermTheme(s: TermScheme): ITheme {
  const t: Record<string, string> = {
    background: s.background,
    foreground: s.foreground,
    cursor: s.cursor,
    cursorAccent: s.background,
    selectionBackground: s.selection,
    // The custom rail replaces xterm's scrollbar; keep the built-in one invisible.
    scrollbarSliderBackground: 'transparent',
    scrollbarSliderHoverBackground: 'transparent',
    scrollbarSliderActiveBackground: 'transparent',
  };
  ANSI_KEYS.forEach((k, i) => {
    t[k] = s.ansi[i] ?? '#888888';
  });
  return t as ITheme;
}

// ------------------------------------------------------------------ search

export interface SearchOpts {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeWord: boolean;
}

/** A run of cells in absolute buffer coordinates. */
export interface CellRange {
  readonly row: number;
  readonly col: number;
  readonly len: number;
}

const MAX_MATCHES = 5000;

/**
 * Every match in the buffer, scrollback included, for the ticks on the scroll
 * rail. Wrapped rows are joined so a match can cross a soft wrap. Highlighting
 * and stepping through matches is done by xterm's search addon.
 */
export function findAll(t: Terminal, query: string, opts: SearchOpts): CellRange[] {
  let re: RegExp;
  try {
    const body = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `\\b(?:${body})\\b` : body, opts.caseSensitive ? 'g' : 'gi');
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

/**
 * Selects what is typed after the prompt on the cursor's line, following the line
 * across wraps, and returns the selected text. The prompt ends at the first "$", "#" or "%" followed by a space.
 */
export function selectCommandLine(t: Terminal): string | null {
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

/** Readline: End, then kill back to the start of the line. Clears the whole typed command. */
export const CLEAR_COMMAND = '\x05\x15';

/** "12m", "3h 04m": how long a shell has been attached. */
export function formatElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
