import { behindExpiredGate } from '../../lib/accessGate';
import { type CSSProperties, type JSX, type MutableRefObject, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SerializeAddon } from '@xterm/addon-serialize';
import { copyToClipboard } from '../../lib/urls';
import { ensureCsrf, setCsrf } from '../../lib/csrf';
import type { TermScheme } from '../../lib/termThemes';
import {
  applyMods,
  CLEAR_COMMAND,
  EARLY_MAX,
  findAll,
  FONT_FAMILY,
  FONT_SIZE,
  selectCommandLine,
  targetLabel,
  xtermTheme,
  type CellRange,
  type Mods,
  type Prefs,
  type SearchOpts,
  type Target,
} from './model';
import { Icon } from './panels';
import { JumpPill, ScrollRail } from './rail';
import type { Dir } from './split';

/**
 * Flow control. xterm parses output on the main thread; when more than HIGH
 * bytes are written and not yet drawn, the server is asked to pause the pty,
 * and to resume once xterm is back under LOW. Ctrl+C stays instant during a flood.
 */
const HIGH = 256 * 1024;
const LOW = 32 * 1024;
/** Size changes reach the server at most this often while a divider is dragged. */
const RESIZE_MS = 60;

const encoder = new TextEncoder();

export type Link = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'exited' | 'elsewhere';

export const LINK_LABEL: Record<Link, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Disconnected',
  exited: 'Exited',
  elsewhere: 'Opened in another tab',
};

/** What the status bar shows for a window. */
export interface WinStatus {
  readonly link: Link;
  readonly mode: string;
  readonly pid: number | null;
  readonly latency: number | null;
  readonly size: string;
  readonly renderer: 'GPU' | 'DOM' | '';
  /** When this shell last attached, for the session timer. */
  readonly since: number | null;
}

export interface SearchResult {
  readonly index: number;
  readonly total: number;
}

/** How the workspace reaches a window's shell. Each window registers one. */
export interface Port {
  /** Raw input to this shell only. */
  readonly send: (data: string) => void;
  /** Paste through xterm (bracketed when the app asked for it), after the multi-line check. */
  readonly paste: (text: string) => void;
  readonly focus: () => void;
  readonly search: (query: string, opts: SearchOpts, dir: -1 | 0 | 1) => SearchResult;
  readonly clearSearch: () => void;
  /** Everything in the buffer as plain text, scrollback included. */
  readonly text: () => string;
  readonly clear: () => void;
  readonly restart: () => void;
  /** A full-screen program (vim, less, htop, tmux) has the alternate screen. */
  readonly altScreen: () => boolean;
}

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
  /** The terminal overlay is open (not hidden behind the dashboard). */
  readonly visible: boolean;
  readonly focused: boolean;
  readonly current: boolean;
  /** Split view with more than one window on screen: each gets its own title strip. */
  readonly framed: boolean;
  /** Shown alone by Alt+Z. */
  readonly zoomed: boolean;
  /** Where the window sits in the split view. */
  readonly style?: CSSProperties;
  /** A remote host instead of a shell here. */
  readonly target?: Target;
  /** Attach this tmux session instead of starting a login shell. */
  readonly tmux?: string;
  /** True for keys the workspace handles (window and tool shortcuts); xterm drops them. */
  readonly ownsKey: (e: KeyboardEvent) => boolean;
  readonly onSplit: (dir: Dir) => void;
  readonly onPaneZoom: () => void;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  readonly onSid: (id: number, sid: string | undefined) => void;
  readonly onTitle: (id: number, title: string) => void;
  readonly onActivity: (id: number) => void;
  readonly onStatus: (id: number, s: WinStatus) => void;
  readonly onZoom: (delta: number) => void;
  /** A sideways one-finger swipe: -1 previous window, 1 next. Phones only. */
  readonly onSwipe?: (dir: -1 | 1) => void;
  readonly onFind: () => void;
  /** Typed input; the workspace decides whether it goes to this shell or to all of them. */
  readonly onInput: (id: number, data: string) => void;
  /** A multi-line paste that needs a yes first. */
  readonly onConfirmPaste: (text: string, go: () => void) => void;
  readonly onCopied: () => void;
  /** A program asked for attention (OSC 777 notify or OSC 9): shown in the page. */
  readonly onNotice: (id: number, text: string) => void;
  /** A runbook step finished in this shell with this exit code (OSC 777 pulse-step). */
  readonly onStep: (id: number, code: number) => void;
  /** Keys typed before this shell could take focus; empties the queue. */
  readonly takeEarly: () => string;
}

interface Menu {
  readonly x: number;
  readonly y: number;
}

interface Cell {
  readonly col: number;
  readonly row: number;
}

/** Where the selection's corners sit in the stage, for the handles and the action bar. */
interface SelView {
  readonly a: { readonly x: number; readonly y: number; readonly on: boolean };
  readonly b: { readonly x: number; readonly y: number; readonly on: boolean };
  readonly h: number;
  /** "Output" can select the last command's output. */
  readonly output: boolean;
}

interface SelApi {
  readonly grab: (which: 'start' | 'end') => void;
  readonly drag: (x: number, y: number) => void;
  readonly copy: () => void;
  readonly lines: () => void;
  readonly all: () => void;
  readonly output: () => void;
  readonly share: () => void;
  readonly exit: () => void;
}

/** How far a selection handle's knob hangs off the text it holds, px. */
const HANDLE_REACH = 14;

/**
 * Rows of the last finished command's output: between the previous prompt line
 * and the prompt the cursor sits on. A prompt is recognised by its `user@host:`
 * start (bash's default), so other prompts and remote shells give null.
 */
export function lastOutput(t: Pick<Terminal, 'buffer'>): { from: number; to: number } | null {
  const buf = t.buffer.active;
  const here = buf.baseY + buf.cursorY;
  const prompt = /^[\w.-]+@[\w.-]+:/.exec(buf.getLine(here)?.translateToString(true) ?? '')?.[0];
  if (!prompt) return null;
  for (let r = here - 1; r >= 0; r -= 1) {
    const line = buf.getLine(r);
    if (!line || line.isWrapped || !line.translateToString(true).startsWith(prompt)) continue;
    let from = r + 1;
    // The command itself may have wrapped onto more rows.
    while (from < here && buf.getLine(from)?.isWrapped) from += 1;
    return from <= here - 1 ? { from, to: here - 1 } : null;
  }
  return null;
}

const INITIAL: WinStatus = { link: 'connecting', mode: '', pid: null, latency: null, size: '', renderer: '', since: null };

/** Search highlight colours. The addon takes #RRGGBB only, so the soft fill is a fixed tint per mode. */
function searchOptions(opts: SearchOpts, scheme: TermScheme): ISearchOptions {
  const active = scheme.dark ? '#ffd400' : '#f0b400';
  return {
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    wholeWord: opts.wholeWord,
    decorations: {
      matchBackground: scheme.dark ? '#5a4b00' : '#fff0b3',
      matchOverviewRuler: active,
      activeMatchBackground: active,
      activeMatchBorder: active,
      activeMatchColorOverviewRuler: active,
    },
  };
}

/** One xterm bound to its own server shell. Reconnects on its own and reattaches by id. */
export function TerminalView(props: ViewProps): JSX.Element {
  const { id, title, fontSize, prefs, scheme, registry, shown, focused, current, framed, zoomed, onFocus } = props;
  const host = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  // Callbacks read through a ref, so the mount effect runs once and never goes stale.
  const live = useRef(props);
  live.current = props;
  const [xt, setXt] = useState<Terminal | null>(null);
  const [link, setLink] = useState<WinStatus['link']>('connecting');
  const [marks, setMarks] = useState<{ all: readonly CellRange[]; current: CellRange | null }>({ all: [], current: null });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [bell, setBell] = useState(0);
  // Tells the server whether anyone sees this shell; set by the mount effect.
  const sendSeen = useRef<() => void>(() => undefined);
  // Phone selection mode: handles and an action bar over a long-pressed selection.
  const [sel, setSel] = useState<SelView | null>(null);
  const selApi = useRef<SelApi | null>(null);

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
        scrollback: p.scrollback,
        macOptionIsMeta: true,
        rightClickSelectsWord: false,
        smoothScrollDuration: 0,
        theme: xtermTheme(schemeRef.current),
      });

      // ---- status, reported up to the workspace's status bar
      let status: WinStatus = INITIAL;
      const report = (patch: Partial<WinStatus>) => {
        status = { ...status, ...patch };
        if (patch.link) setLink(patch.link);
        live.current.onStatus(id, status);
      };

      const fit = new FitAddon();
      fitRef.current = fit;
      t.loadAddon(fit);
      const unicode = new Unicode11Addon();
      t.loadAddon(unicode);
      t.unicode.activeVersion = '11';
      const search = new SearchAddon({ highlightLimit: 2000 });
      t.loadAddon(search);
      const serialize = new SerializeAddon();
      t.loadAddon(serialize);
      // OSC 52: programs on the server (vim, tmux) can put text on this browser's clipboard.
      t.loadAddon(new ClipboardAddon());
      // OSC 777 notify;title;body and OSC 9 text: a program wants attention. In the page
      // that is a toast and the window's bell; with the page away, the server pushes it.
      const onNotice = (text: string) => {
        setBell((n) => n + 1);
        if (!live.current.current) live.current.onActivity(id);
        live.current.onNotice(id, text);
        return true;
      };
      t.parser.registerOscHandler(777, (data) => {
        if (data.startsWith('pulse-step;')) {
          const code = Number(data.slice(11));
          if (Number.isInteger(code)) live.current.onStep(id, code);
          return true;
        }
        if (!data.startsWith('notify;')) return false;
        const [title = '', ...body] = data.slice(7).split(';');
        return onNotice([title, body.join(';')].filter(Boolean).join(': ') || 'Done');
      });
      t.parser.registerOscHandler(9, (data) => (/^\d+(;|$)/.test(data) ? false : onNotice(data)));
      t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
      t.open(el);
      term.current = t;
      // Phone keyboards must not "help": no capital first letter, autocorrect,
      // suggestions or spell check in what goes to the shell.
      const ta = t.textarea;
      if (ta) {
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('spellcheck', 'false');
        ta.setAttribute('enterkeyhint', 'send');
        ta.setAttribute('data-gramm', 'false');
      }

      // GPU rendering: the whole screen is one texture-atlas draw per frame, so
      // heavy output and scrolling stay smooth. Without WebGL, or if the context
      // is lost (GPU reset, too many tabs), xterm falls back to its DOM renderer.
      let webgl: WebglAddon | null = null;
      const useDom = () => {
        webgl?.dispose();
        webgl = null;
        report({ renderer: 'DOM' });
      };
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(useDom);
        t.loadAddon(webgl);
        report({ renderer: 'GPU' });
      } catch {
        useDom();
      }
      fit.fit();

      // ---- connection
      let ws: WebSocket | null = null;
      let connected = false;
      let sid = live.current.sid;
      let retries = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let ending = false;
      let restarting = false;
      // Typed before the shell first answers: held, then sent on connect.
      let everConnected = false;
      let disposed = false;
      let pending = '';
      // Server speaks binary frames (newer servers say so in hello); else JSON input.
      let binary = false;
      const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
      const sendInput = (data: string) => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        if (binary) ws.send(encoder.encode(data));
        else ws.send(JSON.stringify({ type: 'input', data }));
      };
      const input = (data: string) => {
        if (connected) sendInput(data);
        else if (!everConnected && pending.length < EARLY_MAX) pending += data;
      };

      // ---- flow control: bytes handed to xterm and not yet parsed
      let backlog = 0;
      let held = false;
      const write = (chunk: Uint8Array | string) => {
        const size = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
        backlog += size;
        t.write(chunk, () => {
          backlog -= size;
          if (held && backlog < LOW) {
            held = false;
            send({ type: 'resume' });
          }
        });
        if (!held && backlog > HIGH) {
          held = true;
          send({ type: 'pause' });
        }
      };

      // ---- size: xterm refits every frame during a drag; the pty hears about it less often
      let sizeTimer: ReturnType<typeof setTimeout> | undefined;
      let sentSize = '';
      const sendSize = () => {
        clearTimeout(sizeTimer);
        sizeTimer = undefined;
        const size = `${t.cols}x${t.rows}`;
        if (size === sentSize || !connected) return;
        sentSize = size;
        send({ type: 'resize', cols: t.cols, rows: t.rows });
      };

      // ---- search: the addon highlights and steps; findAll feeds the rail ticks
      let lastQuery = '';
      let lastOpts: SearchOpts = { caseSensitive: false, regex: false, wholeWord: false };
      let result = { index: 0, total: 0 };
      const results = search.onDidChangeResults((r) => {
        result = { index: Math.max(0, r.resultIndex), total: r.resultCount };
      });
      const currentMark = (): CellRange | null => {
        const pos = t.getSelectionPosition();
        return pos ? { row: pos.start.y, col: pos.start.x, len: 1 } : null;
      };

      const pasteChecked = (text: string) => {
        const multi = /\r?\n./.test(text.replace(/\r?\n$/, ''));
        if (multi && live.current.prefs.confirmPaste && !t.modes.bracketedPasteMode) {
          live.current.onConfirmPaste(text, () => t.paste(text));
        } else {
          t.paste(text);
        }
      };

      registry.current.set(id, {
        send: input,
        paste: pasteChecked,
        focus: () => t.focus(),
        search: (q, opts, dir) => {
          const so = searchOptions(opts, schemeRef.current);
          const changed = q !== lastQuery || opts.caseSensitive !== lastOpts.caseSensitive || opts.regex !== lastOpts.regex || opts.wholeWord !== lastOpts.wholeWord;
          if (!q) {
            search.clearDecorations();
            setMarks({ all: [], current: null });
            lastQuery = '';
            return { index: 0, total: 0 };
          }
          if (changed) {
            lastQuery = q;
            lastOpts = opts;
            // Start from the bottom, where the person is looking.
            search.findPrevious(q, { ...so, incremental: false });
            setMarks({ all: findAll(t, q, opts), current: null });
          } else if (dir === -1) search.findPrevious(q, so);
          else if (dir === 1) search.findNext(q, so);
          else search.findPrevious(q, { ...so, incremental: true });
          setMarks((m) => ({ all: m.all, current: currentMark() }));
          return result;
        },
        clearSearch: () => {
          search.clearDecorations();
          t.clearSelection();
          lastQuery = '';
          setMarks({ all: [], current: null });
        },
        text: () => serialize.serialize({ excludeAltBuffer: true, excludeModes: true }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
        clear: () => {
          t.clear();
          input('\x0c');
        },
        altScreen: () => t.buffer.active.type === 'alternate',
        restart: () => {
          restarting = true;
          if (connected) send({ type: 'kill' });
          else {
            restarting = false;
            t.reset();
            connect(true);
          }
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

      // Keys the workspace owns. Returning false stops xterm from sending them to the shell.
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        // Esc at the normal screen goes back to the dashboard (the workspace handles it).
        // In a full-screen program (alternate screen: vim, less, htop) it stays the program's.
        // Ctrl+[ is not caught here and always sends Esc to the shell.
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && t.buffer.active.type === 'normal') return false;
        if (live.current.ownsKey(e)) return false;
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
          void copyToClipboard(t.getSelection()).then((ok) => ok && live.current.onCopied());
          t.clearSelection();
          return false;
        }
        return true;
      });

      // Copy on select: when the mouse lets go of a selection.
      const onMouseUp = () => {
        if (!live.current.prefs.copyOnSelect || !t.hasSelection() || replacing()) return;
        const text = t.getSelection();
        if (text) void copyToClipboard(text).then((ok) => ok && live.current.onCopied());
      };
      el.addEventListener('mouseup', onMouseUp);

      const note = (msg: string, color = 33) => t.write(`\r\n\x1b[${color}m${msg}\x1b[0m\r\n`);

      // The upgrade carries the session's CSRF token as a subprotocol (headers cannot be set).
      const connect = (fresh = false) => {
        clearTimeout(retryTimer);
        if (fresh) sid = undefined;
        void ensureCsrf().then((csrf) => {
          if (!disposed) openSocket(csrf);
        });
      };
      const openSocket = (csrf: string | null) => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const q = new URLSearchParams({ cols: String(t.cols), rows: String(t.rows) });
        const target = live.current.target;
        const tmux = live.current.tmux;
        if (sid) q.set('sid', sid);
        else if (tmux) q.set('tmux', tmux);
        else if (target) {
          q.set('proto', target.proto);
          q.set('host', target.host);
          q.set('port', String(target.port));
          if (target.user) q.set('user', target.user);
          if (target.legacy) q.set('legacy', '1');
        }
        const socket = new WebSocket(`${proto}://${window.location.host}/api/terminal?${q}`, csrf ? ['pulse.v1', `pulse.csrf.${csrf}`] : ['pulse.v1']);
        let helloSeen = false;
        socket.binaryType = 'arraybuffer';
        ws = socket;
        connected = false;
        binary = false;
        // A new socket starts with nothing queued on either side.
        held = false;
        sentSize = '';
        let gotReplay = false;
        if (!sid && target) note(`Connecting to ${target.proto === 'ssh' ? 'SSH' : 'Telnet'} ${targetLabel(target)}…`, 90);
        socket.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(e.data);
            write(bytes);
            if (gotReplay) {
              gotReplay = false;
              // Full-screen apps repaint for the current size once the replay is in.
              setTimeout(() => send({ type: 'redraw' }), 60);
            }
            if (!live.current.current || document.hidden) live.current.onActivity(id);
            return;
          }
          let msg: { t?: string; d?: string; sid?: string; resumed?: boolean; reattached?: boolean; tmux?: string | null; mode?: string; pid?: number; code?: number; ts?: number; bin?: boolean };
          try {
            msg = JSON.parse(String(e.data));
          } catch {
            return;
          }
          if (msg.t === 'hello' && msg.sid) {
            connected = true;
            sendSeen.current();
            helloSeen = true;
            binary = msg.bin === true;
            retries = 0;
            lastPong = performance.now();
            everConnected = true;
            if (pending) {
              sendInput(pending);
              pending = '';
            }
            // A tmux window that lost its link attaches the same session again: nothing ended.
            if (sid && !msg.resumed && !msg.reattached && !msg.tmux) note('[previous shell has ended — this is a new one]', 90);
            // Same shell, kept by dtach across a server restart; its earlier output is not.
            if (msg.reattached) note('[reattached to your running shell]', 90);
            if (msg.resumed) {
              // The replay rebuilds the screen from scratch.
              t.reset();
              gotReplay = true;
            }
            sid = msg.sid;
            live.current.onSid(id, sid);
            report({ link: 'live', mode: target ? target.proto : (msg.mode ?? ''), pid: typeof msg.pid === 'number' ? msg.pid : null, since: Date.now() });
            sendSize();
          } else if (msg.t === 'o' && msg.d) {
            write(msg.d);
            if (gotReplay) {
              gotReplay = false;
              // Full-screen apps repaint for the current size once the replay is in.
              setTimeout(() => send({ type: 'redraw' }), 60);
            }
            if (!live.current.current || document.hidden) live.current.onActivity(id);
          } else if (msg.t === 'exit') {
            if (restarting) return;
            ending = true;
            report({ link: 'exited', latency: null });
            const remote = live.current.target;
            if (remote) note(`[connection to ${targetLabel(remote)} closed${msg.code ? ` (${msg.code})` : ''} — press Enter to connect again]`);
            else note(`[process exited${msg.code ? ` with ${msg.code}` : ''} — press Enter for a new shell]`);
          } else if (msg.t === 'pong' && typeof msg.ts === 'number') {
            lastPong = performance.now();
            const ms = Math.max(0, Math.round(performance.now() - msg.ts));
            if (ms !== status.latency) report({ latency: ms });
          }
        };
        socket.onclose = (ev) => {
          if (ws !== socket) return;
          // Refused before hello: the token may be stale (new login, server key change). Fetch it again.
          if (!helloSeen) setCsrf(null);
          connected = false;
          report({ latency: null });
          if (restarting) {
            restarting = false;
            ending = false;
            t.reset();
            report({ link: 'connecting' });
            connect(true);
            return;
          }
          if (ending || ev.code === 4401 || ev.code === 1011 || (!everConnected && ev.code === 1006 && retries >= 2)) {
            if (ev.code === 4401) note('[logged out]', 31);
            else if (!everConnected && !ending) note('[could not connect — press Enter to try again]', 31);
            if (!ending) report({ link: 'offline' });
            sid = undefined;
            live.current.onSid(id, undefined);
            return;
          }
          if (ev.code === 4409) {
            report({ link: 'elsewhere' });
            note('[this shell was opened in another tab — press Enter to take it back]');
            return;
          }
          // Dropped: reattach on our own. A phone in the background (another app
          // in front) gets no tries at all: they would only fail and use up the
          // budget. Coming back to the page reconnects at once (see revive).
          report({ link: 'reconnecting' });
          if (document.hidden) return;
          scheduleRetry();
        };
      };
      // While visible, never give up: back off to every 8 s, and after the first
      // eight tries say so once, but keep trying (a phone on the move drops a lot).
      const scheduleRetry = () => {
        clearTimeout(retryTimer);
        const wait = Math.min(8000, 400 * 2 ** retries);
        retries += 1;
        // Several failures in a row: maybe Cloudflare Access wants a new sign-in, not a dead server.
        if (retries === 3)
          void behindExpiredGate().then((gated) => {
            if (gated && !disposed) note('[Cloudflare Access sign-in expired — reload the page to sign in again]', 31);
          });
        if (retries === 9) {
          report({ link: 'offline' });
          note('[connection lost — still trying, or press Enter]');
        }
        retryTimer = setTimeout(() => connect(), wait);
      };

      // Back from another app, the network coming back, or the page restored from
      // the back-forward cache. A socket that still says OPEN may be dead (the OS
      // froze it), so it must answer a ping quickly or it is replaced.
      let lastPong = performance.now();
      let probe: ReturnType<typeof setTimeout> | undefined;
      const replace = () => {
        const old = ws;
        ws = null;
        connected = false;
        old?.close();
        retries = 0;
        report({ link: 'reconnecting' });
        connect();
      };
      const revive = () => {
        if (disposed || ending || document.hidden) return;
        const state = ws?.readyState;
        if (state === WebSocket.OPEN && connected) {
          const asked = performance.now();
          send({ type: 'ping', ts: asked });
          clearTimeout(probe);
          probe = setTimeout(() => {
            if (lastPong < asked && ws?.readyState === WebSocket.OPEN) replace();
          }, 2500);
          return;
        }
        if (state === WebSocket.CONNECTING) return;
        // Closed while we were away: go now, not after the backoff.
        clearTimeout(retryTimer);
        retries = 0;
        report({ link: 'reconnecting' });
        connect();
      };
      sendSeen.current = () => send({ type: 'seen', visible: !document.hidden && live.current.visible, name: live.current.title });
      const onVisible = () => {
        sendSeen.current();
        if (!document.hidden) revive();
      };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', revive);
      window.addEventListener('pageshow', revive);
      window.addEventListener('focus', revive);

      connect();

      const ping = setInterval(() => {
        if (!connected || document.hidden) return;
        send({ type: 'ping', ts: performance.now() });
        // No pong for a long while on a visible page: the link is dead without a close event.
        if (performance.now() - lastPong > 15000) replace();
      }, 4000);

      const data = t.onData((raw) => {
        // Ctrl or Alt armed on the key bar applies to the next character typed.
        const mods = live.current.modsRef.current;
        const armed = mods.ctrl !== 'off' || mods.alt !== 'off';
        const out = armed ? applyMods(raw, mods) : raw;
        if (armed) live.current.onModsUsed();
        if (connected) live.current.onInput(id, out);
        else if (!everConnected && ws?.readyState === WebSocket.CONNECTING) input(out);
        else if (out === '\r' && ws?.readyState !== WebSocket.CONNECTING && ws?.readyState !== WebSocket.OPEN) {
          const fresh = ending;
          ending = false;
          retries = 0;
          report({ link: 'connecting' });
          connect(fresh);
        }
      });
      // Native paste (Ctrl+V, middle click): same multi-line check, and it replaces a Ctrl+A selection.
      const onPaste = (e: ClipboardEvent) => {
        if (replacing()) dropSelection();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        const multi = /\r?\n./.test(text.replace(/\r?\n$/, ''));
        if (multi && live.current.prefs.confirmPaste && !t.modes.bracketedPasteMode) {
          e.preventDefault();
          e.stopImmediatePropagation();
          live.current.onConfirmPaste(text, () => t.paste(text));
        }
      };
      t.textarea?.addEventListener('paste', onPaste, true);
      const resize = t.onResize(({ cols, rows }) => {
        report({ size: `${cols}×${rows}` });
        if (!sizeTimer) sizeTimer = setTimeout(sendSize, RESIZE_MS);
      });
      report({ size: `${t.cols}×${t.rows}` });
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

      // Touch gestures (phones):
      //  - two fingers pinch the text size, one step per PINCH_STEP px of spread;
      //  - one finger, in a full-screen program (vim, less, htop) that does not
      //    take the mouse, a vertical drag sends arrow keys, one per text row;
      //  - one finger, a quick sideways swipe goes to the previous or next window;
      //  - a long press selects the word under the finger (the line, on a blank)
      //    and copies it.
      const PINCH_STEP = 28;
      const LONG_PRESS_MS = 480;
      type Gesture =
        | { kind: 'pinch'; base: number }
        | { kind: 'one'; x0: number; y0: number; t0: number; lastY: number; moved: boolean; arrows: boolean; longTimer: number; selected: boolean };
      let g: Gesture | null = null;
      const spread = (e: TouchEvent) => {
        const [a, b] = [e.touches[0], e.touches[1]];
        return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
      };
      const cell = () => {
        const screen = el.querySelector<HTMLElement>('.xterm-screen');
        const box = screen?.getBoundingClientRect();
        return box && t.cols > 0 && t.rows > 0 ? { box, w: box.width / t.cols, h: box.height / t.rows } : null;
      };
      // ---- selection mode (phones). A long press selects the word under the finger
      // (the line, on a blank) and shows two handles to widen it and a bar of actions.
      // Rows are buffer rows (scrollback included), end inclusive.
      let range: { start: Cell; end: Cell } | null = null;
      let output: { from: number; to: number } | null = null;
      const cellAt = (x: number, y: number): Cell | null => {
        const c = cell();
        if (!c) return null;
        let row = Math.floor((y - c.box.top) / c.h);
        // Dragged past the top or bottom: scroll a line and stay on the edge row.
        if (row < 0) {
          t.scrollLines(-1);
          row = 0;
        } else if (row >= t.rows) {
          t.scrollLines(1);
          row = t.rows - 1;
        }
        const col = Math.min(t.cols - 1, Math.max(0, Math.floor((x - c.box.left) / c.w)));
        return { col, row: row + t.buffer.active.viewportY };
      };
      const before = (a: Cell, b: Cell) => a.row < b.row || (a.row === b.row && a.col <= b.col);
      /** Draws `range`: xterm's selection, then the handles and the bar where it sits now. */
      const showSel = (reselect = true) => {
        const c = cell();
        const stage = el.parentElement?.getBoundingClientRect();
        if (!range || !c || !stage) return;
        const { start, end } = range;
        if (reselect) t.select(start.col, start.row, (end.row - start.row) * t.cols + end.col - start.col + 1);
        const vy = t.buffer.active.viewportY;
        const at = (col: number, row: number) => ({ x: c.box.left - stage.left + col * c.w, y: c.box.top - stage.top + (row - vy) * c.h, on: row >= vy && row < vy + t.rows });
        setSel({ a: at(start.col, start.row), b: at(end.col + 1, end.row + 1), h: c.h, output: output !== null });
      };
      const exitSel = () => {
        if (!range) return;
        range = null;
        t.clearSelection();
        setSel(null);
      };
      const selectAt = (x: number, y: number) => {
        const c = cell();
        if (!c) return;
        const col = Math.floor((x - c.box.left) / c.w);
        const row = Math.floor((y - c.box.top) / c.h) + t.buffer.active.viewportY;
        const line = t.buffer.active.getLine(row)?.translateToString(true) ?? '';
        if (col < 0 || col >= t.cols || !line) return;
        const isWord = (ch: string | undefined) => !!ch && !/\s/.test(ch);
        let start = col;
        let end = col;
        if (isWord(line[col])) {
          while (start > 0 && isWord(line[start - 1])) start -= 1;
          while (end < line.length - 1 && isWord(line[end + 1])) end += 1;
        } else {
          start = 0;
          end = t.cols - 1;
        }
        range = { start: { col: start, row }, end: { col: end, row } };
        output = lastOutput(t);
        showSel();
        navigator.vibrate?.(12);
      };
      const scrollSub = t.onScroll(() => range && showSel(false));
      let dragging: 'start' | 'end' | null = null;
      selApi.current = {
        grab: (which) => {
          dragging = which;
        },
        drag: (x, y) => {
          const c = cell();
          if (!range || !dragging || !c) return;
          // The finger sits on the knob, which hangs above the start and below the end.
          const p = cellAt(x, dragging === 'start' ? y + HANDLE_REACH + c.h / 2 : y - HANDLE_REACH - c.h / 2);
          if (!p) return;
          if (dragging === 'start') range = before(p, range.end) ? { start: p, end: range.end } : ((dragging = 'end'), { start: range.end, end: p });
          else range = before(range.start, p) ? { start: range.start, end: p } : ((dragging = 'start'), { start: p, end: range.start });
          showSel();
        },
        copy: () => {
          void copyToClipboard(t.getSelection()).then((ok) => ok && live.current.onCopied());
          exitSel();
        },
        lines: () => {
          if (!range) return;
          range = { start: { col: 0, row: range.start.row }, end: { col: t.cols - 1, row: range.end.row } };
          showSel();
        },
        all: () => {
          const last = t.buffer.active.length - 1;
          range = { start: { col: 0, row: 0 }, end: { col: t.cols - 1, row: last } };
          showSel();
        },
        output: () => {
          if (!output) return;
          range = { start: { col: 0, row: output.from }, end: { col: t.cols - 1, row: output.to } };
          showSel();
          t.scrollToLine(output.from);
        },
        share: () => {
          const text = t.getSelection();
          exitSel();
          void navigator.share?.({ text }).catch(() => undefined);
        },
        exit: exitSel,
      };
      const onTouchStart = (e: TouchEvent) => {
        if (g?.kind === 'one') clearTimeout(g.longTimer);
        // A new touch on the text while selecting: a tap ends the mode (see touchend).
        if (range && e.touches.length === 1) {
          const p = e.touches[0]!;
          g = { kind: 'one', x0: p.clientX, y0: p.clientY, t0: Date.now(), lastY: p.clientY, moved: false, arrows: false, longTimer: 0, selected: true };
          return;
        }
        if (e.touches.length === 2) {
          g = { kind: 'pinch', base: spread(e) };
          return;
        }
        if (e.touches.length !== 1) {
          g = null;
          return;
        }
        const p = e.touches[0]!;
        const alt = t.buffer.active.type === 'alternate' && t.modes.mouseTrackingMode === 'none';
        const longTimer = window.setTimeout(() => {
          if (g?.kind === 'one' && !g.moved) {
            selectAt(g.x0, g.y0);
            g.selected = range !== null;
          }
        }, LONG_PRESS_MS);
        g = { kind: 'one', x0: p.clientX, y0: p.clientY, t0: Date.now(), lastY: p.clientY, moved: false, arrows: alt, longTimer, selected: false };
      };
      const onTouchMove = (e: TouchEvent) => {
        if (!g) return;
        if (g.kind === 'pinch' && e.touches.length === 2) {
          e.preventDefault();
          const d = spread(e);
          if (Math.abs(d - g.base) >= PINCH_STEP) {
            live.current.onZoom(d > g.base ? 1 : -1);
            g.base = d;
          }
          return;
        }
        const p = e.touches[0];
        if (g.kind !== 'one' || !p) return;
        if (!g.moved && Math.hypot(p.clientX - g.x0, p.clientY - g.y0) > 10) {
          g.moved = true;
          clearTimeout(g.longTimer);
        }
        if (g.arrows) {
          e.preventDefault();
          const h = cell()?.h ?? 16;
          const app = t.modes.applicationCursorKeysMode;
          while (Math.abs(p.clientY - g.lastY) >= h) {
            const up = p.clientY > g.lastY; // finger down: earlier content, like scrolling
            input(up ? (app ? '\x1bOA' : '\x1b[A') : app ? '\x1bOB' : '\x1b[B');
            g.lastY += up ? h : -h;
          }
        }
      };
      const onTouchEnd = (e: TouchEvent) => {
        if (g?.kind === 'one') {
          clearTimeout(g.longTimer);
          if (g.selected) {
            // Keep the browser from turning the lift into a click that clears the selection.
            if (e.cancelable) e.preventDefault();
            // A tap (no drag, not the long press that started the mode) leaves selection mode.
            if (!g.moved && g.longTimer === 0) exitSel();
            g = null;
            return;
          }
          const p = e.changedTouches[0];
          if (p && !g.arrows && live.current.onSwipe) {
            const dx = p.clientX - g.x0;
            const dy = p.clientY - g.y0;
            if (Math.abs(dx) > 70 && Math.abs(dy) < 40 && Date.now() - g.t0 < 450) live.current.onSwipe(dx < 0 ? 1 : -1);
          }
        }
        if (e.touches.length === 0) g = null;
      };
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      el.addEventListener('touchend', onTouchEnd, { passive: false });
      el.addEventListener('touchcancel', onTouchEnd, { passive: true });

      // Fires whenever the window changes size or goes from hidden to shown.
      // Batched to one fit per frame: a drag-resize fires this dozens of times.
      let fitFrame = 0;
      const observer = new ResizeObserver(() => {
        if (fitFrame) return;
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0;
          if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
        });
      });
      observer.observe(el);
      setXt(t);

      return () => {
        // Closing the window ends its shell. A page unload never gets here, so a
        // reload leaves the shell running for the next page to reattach.
        disposed = true;
        send({ type: 'kill' });
        registry.current.delete(id);
        fitRef.current = null;
        clearTimeout(retryTimer);
        clearTimeout(sizeTimer);
        clearInterval(ping);
        clearTimeout(probe);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', revive);
        window.removeEventListener('pageshow', revive);
        window.removeEventListener('focus', revive);
        cancelAnimationFrame(fitFrame);
        el.removeEventListener('wheel', onWheel, { capture: true });
        el.removeEventListener('touchstart', onTouchStart);
        el.removeEventListener('touchmove', onTouchMove);
        el.removeEventListener('touchend', onTouchEnd);
        el.removeEventListener('touchcancel', onTouchEnd);
        if (g?.kind === 'one') clearTimeout(g.longTimer);
        el.removeEventListener('mouseup', onMouseUp);
        t.textarea?.removeEventListener('paste', onPaste, true);
        results.dispose();
        titleSub.dispose();
        bellSub.dispose();
        scrollSub.dispose();
        selApi.current = null;
        observer.disconnect();
        data.dispose();
        resize.dispose();
        const old = ws;
        ws = null;
        old?.close();
        term.current = null;
        setXt(null);
        webgl?.dispose();
        t.dispose();
      };
    };

    // xterm measures a character cell when it opens, so the font has to be loaded first.
    void document.fonts
      .load(`400 ${FONT_SIZE}px "JetBrains Mono"`)
      .then(() =>
        Promise.all([
          document.fonts.load(`500 ${FONT_SIZE}px "JetBrains Mono"`),
          document.fonts.load(`700 ${FONT_SIZE}px "JetBrains Mono"`),
          document.fonts.load(`italic 400 ${FONT_SIZE}px "JetBrains Mono"`),
        ]),
      )
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
    t.options.scrollback = prefs.scrollback;
    fitRef.current?.fit();
  }, [fontSize, prefs.lineHeight, prefs.cursorStyle, prefs.blink, prefs.weight, prefs.boldBright, prefs.scrollback, xt]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.theme = xtermTheme(scheme);
  }, [scheme, xt]);

  useEffect(() => sendSeen.current(), [props.visible, title]);

  useEffect(() => {
    if (!bell || !win.current) return;
    const el = win.current;
    el.classList.remove('is-bell');
    void el.offsetWidth;
    el.classList.add('is-bell');
  }, [bell]);

  // Any click elsewhere closes the menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const menuAction = (what: 'copy' | 'paste' | 'all' | 'clear' | 'find' | 'top' | 'bottom' | 'restart') => {
    const t = term.current;
    const port = registry.current.get(id);
    setMenu(null);
    if (!t) return;
    if (what === 'copy' && t.hasSelection()) void copyToClipboard(t.getSelection()).then((ok) => ok && props.onCopied());
    else if (what === 'paste') void navigator.clipboard?.readText().then((x) => port?.paste(x)).catch(() => undefined);
    else if (what === 'all') t.selectAll();
    else if (what === 'clear') port?.clear();
    else if (what === 'find') props.onFind();
    else if (what === 'top') t.scrollToTop();
    else if (what === 'bottom') t.scrollToBottom();
    else if (what === 'restart') port?.restart();
    t.focus();
  };

  return (
    <section
      ref={win}
      className={`tw-win${shown ? '' : ' is-off'}${current ? ' is-current' : ''}${framed ? ' is-framed' : ''} is-${link}`}
      style={props.style}
      aria-label={title}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        const box = win.current?.getBoundingClientRect();
        if (!box || e.shiftKey) return;
        e.preventDefault();
        // Keep the menu inside the window.
        setMenu({ x: Math.min(e.clientX - box.left, box.width - 220), y: Math.min(e.clientY - box.top, box.height - 300) });
      }}
    >
      {(framed || zoomed) && (
        <header className="tw-win-head" onDoubleClick={props.onPaneZoom}>
          <span className={`tw-led is-${link}`} aria-hidden="true" />
          {props.target && <span className="tw-proto">{props.target.proto === 'ssh' ? 'SSH' : 'TEL'}</span>}
          <span className="tw-win-title">{title}</span>
          <span className="tw-win-tools" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <button type="button" className="tw-win-x" aria-label="Split right" title="Split right (Alt+\\)" onClick={() => props.onSplit('row')}>
              <Icon.splitRight size={14} />
            </button>
            <button type="button" className="tw-win-x" aria-label="Split down" title="Split down (Alt+-)" onClick={() => props.onSplit('col')}>
              <Icon.splitDown size={14} />
            </button>
            <button type="button" className={`tw-win-x${zoomed ? ' is-on' : ''}`} aria-pressed={zoomed} aria-label={zoomed ? 'Unzoom' : 'Zoom'} title="Zoom (Alt+Z)" onClick={props.onPaneZoom}>
              {zoomed ? <Icon.shrink size={14} /> : <Icon.expand size={14} />}
            </button>
            <button type="button" className="tw-win-x" aria-label={`Close ${title}`} title="Close (Alt+W)" onClick={props.onClose}>
              <Icon.close size={14} />
            </button>
          </span>
        </header>
      )}
      <div className="tw-stage">
        <div ref={host} className="tw-term" />
        {xt && <ScrollRail term={xt} marks={marks.all} current={marks.current} />}
        {xt && <JumpPill term={xt} />}
        {sel && (
          <>
            {(['start', 'end'] as const).map((which) => {
              const at = which === 'start' ? sel.a : sel.b;
              if (!at.on) return null;
              return (
                <span
                  key={which}
                  className={`tw-sel-handle is-${which}`}
                  style={{ left: at.x, top: at.y, '--sel-line': `${sel.h}px` } as CSSProperties}
                  aria-hidden="true"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    selApi.current?.grab(which);
                  }}
                  onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && selApi.current?.drag(e.clientX, e.clientY)}
                />
              );
            })}
            <div
              className="tw-sel-bar"
              role="toolbar"
              aria-label="Selection"
              // Above the selection when there is room, else under it.
              style={{ top: sel.a.on && sel.a.y > 64 ? sel.a.y - 54 : Math.min((host.current?.clientHeight ?? 200) - 48, (sel.b.on ? sel.b.y : 0) + 22) }}
              onPointerDown={(e) => e.preventDefault()}
            >
              <button type="button" onClick={() => selApi.current?.copy()}>
                Copy
              </button>
              <button type="button" onClick={() => selApi.current?.lines()}>
                Lines
              </button>
              {sel.output && (
                <button type="button" onClick={() => selApi.current?.output()}>
                  Output
                </button>
              )}
              <button type="button" onClick={() => selApi.current?.all()}>
                All
              </button>
              {typeof navigator.share === 'function' && (
                <button type="button" aria-label="Share" onClick={() => selApi.current?.share()}>
                  <Icon.share size={15} />
                </button>
              )}
              <button type="button" aria-label="Done selecting" onClick={() => selApi.current?.exit()}>
                <Icon.close size={15} />
              </button>
            </div>
          </>
        )}
      </div>
      {menu && (
        <div
          className="tw-menu"
          role="menu"
          style={{ left: Math.max(4, menu.x), top: Math.max(4, menu.y) }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
            Clear screen and scrollback
          </button>
          <button type="button" role="menuitem" onClick={() => menuAction('restart')}>
            Restart shell
          </button>
        </div>
      )}
    </section>
  );
}
