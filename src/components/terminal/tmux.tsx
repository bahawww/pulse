import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { postJson } from '../../lib/csrf';
import { TMUX_RE } from './model';
import { Icon, Popover } from './panels';

/**
 * tmux session manager. Sessions live on the server (src/server/tmux.ts) and
 * outlast any browser: start one here on a laptop, attach the same one from a
 * phone, and both see it live. Attaching opens a terminal window; closing that
 * window only detaches.
 */

interface Session {
  readonly name: string;
  readonly windows: number;
  readonly attached: number;
  readonly created: number;
  readonly activity: number;
}

interface TmuxProps {
  /** tmux sessions already open in a window of this tab. */
  readonly openHere: ReadonlySet<string>;
  readonly onAttach: (name: string) => void;
  readonly onClose: () => void;
  readonly onNotify: (msg: string) => void;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A name that is not taken yet: main, main-2, main-3 … */
function freeName(base: string, taken: readonly Session[]): string {
  const names = new Set(taken.map((t) => t.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

export function TmuxPanel({ openHere, onAttach, onClose, onNotify }: TmuxProps): JSX.Element {
  const [list, setList] = useState<readonly Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tmux', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const body = (await res.json().catch(() => ({}))) as { sessions?: Session[]; error?: string };
      if (!res.ok) {
        setError(body.error ?? `failed (${res.status})`);
        return;
      }
      setList(body.sessions ?? []);
      setError(null);
    } catch {
      setError('server unreachable');
    }
  }, []);

  useEffect(() => {
    void load();
    input.current?.focus();
    // Other devices attach and detach: keep the counts fresh while open.
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const attach = (n: string) => {
    onAttach(n);
    onClose();
  };

  const create = () => {
    const wanted = name.trim();
    if (wanted && !TMUX_RE.test(wanted)) {
      onNotify('Names: letters, digits, _ and -');
      return;
    }
    attach(wanted || freeName('main', list ?? []));
  };

  const post = async (path: string, body: object, done: string) => {
    const res = await postJson(path, body).catch(() => null);
    if (!res) onNotify('server unreachable');
    else if (!res.ok) onNotify(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'failed');
    else onNotify(done);
    await load();
  };

  return (
    <Popover id="tmux" label="tmux sessions" onClose={onClose} className="tw-pop-conn">
      <form
        className="tw-snip-top"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          ref={input}
          className="tw-snip-search"
          placeholder="New session name (blank: main)"
          aria-label="New tmux session name"
          value={name}
          maxLength={40}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <button type="submit" className="tw-icon-btn" aria-label="New session" title="New session (Enter)">
          <Icon.plus />
        </button>
        <button type="button" className="tw-icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
          <Icon.restart />
        </button>
      </form>

      <ul className="tw-snips tw-conns" aria-label="tmux sessions">
        {error && <li className="tw-snip-empty">{error}</li>}
        {!error && list === null && <li className="tw-snip-empty">Loading…</li>}
        {!error && list?.length === 0 && <li className="tw-snip-empty">No tmux sessions yet. Type a name and press Enter to start one.</li>}
        {list?.map((s) => {
          const here = openHere.has(s.name);
          if (renaming === s.name) {
            return (
              <li key={s.name}>
                <form
                  className="tw-tmux-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const to = String(new FormData(e.currentTarget).get('to') ?? '').trim();
                    setRenaming(null);
                    if (to && to !== s.name) void post('/api/tmux/rename', { name: s.name, to }, `Renamed to ${to}`);
                  }}
                >
                  <input name="to" defaultValue={s.name} maxLength={40} autoFocus spellCheck={false} autoCapitalize="off" aria-label={`New name for ${s.name}`} />
                  <button type="submit" className="btn btn-sm btn-primary">Rename</button>
                  <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              </li>
            );
          }
          if (killing === s.name) {
            return (
              <li key={s.name} className="tw-tmux-confirm">
                <span>
                  Kill <strong>{s.name}</strong>? Everything running in it stops{s.attached > 0 ? `, on ${s.attached} attached device${s.attached === 1 ? '' : 's'} too` : ''}.
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    setKilling(null);
                    void post('/api/tmux/kill', { name: s.name }, `Killed ${s.name}`);
                  }}
                >
                  Kill
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setKilling(null)}>Cancel</button>
              </li>
            );
          }
          return (
            <li key={s.name}>
              <button type="button" className="tw-snip-main tw-conn-main" onClick={() => attach(s.name)} title={here ? 'Already open here: go to it' : 'Attach in a new window'}>
                <span className={`tw-proto${s.attached > 0 ? ' is-live' : ''}`}>{s.attached > 0 ? 'live' : 'idle'}</span>
                <span className="tw-conn-text">
                  <span className="tw-snip-label">
                    {s.name}
                    {here && <span className="tw-tmux-here"> · open here</span>}
                  </span>
                  <code>
                    {s.windows} window{s.windows === 1 ? '' : 's'} · {s.attached} attached · active {ago(s.activity)}
                  </code>
                </span>
              </button>
              <span className="tw-snip-tools">
                <button type="button" className="tw-icon-btn is-sm" aria-label={`Rename ${s.name}`} title="Rename" onClick={() => setRenaming(s.name)}>
                  <Icon.edit />
                </button>
                <button type="button" className="tw-icon-btn is-sm" aria-label={`Kill ${s.name}`} title="Kill session" onClick={() => setKilling(s.name)}>
                  <Icon.trash />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="tw-pop-foot">
        Sessions keep running on the server. Attach the same one from any device; closing a window only detaches. In tmux: Ctrl+B then D detaches, Ctrl+B then C opens a tmux window.
      </p>
    </Popover>
  );
}
