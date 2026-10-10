import { type JSX, useEffect, useRef, useState } from 'react';
import { DEFAULT_PORT, newId, parseQuick, targetLabel, validHost, validUser, type Conn, type Proto, type Target } from './model';
import { Icon, Popover } from './panels';

interface ConnectProps {
  readonly list: readonly Conn[];
  readonly onChange: (list: readonly Conn[]) => void;
  /** Opens a new window connected to `t`. */
  readonly onConnect: (t: Target, name: string) => void;
  readonly onClose: () => void;
}

interface Draft {
  readonly id: string;
  readonly name: string;
  readonly proto: Proto;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly legacy: boolean;
}

const blank = (): Draft => ({ id: newId(), name: '', proto: 'ssh', host: '', port: '', user: '', legacy: false });

function draftTarget(d: Draft): Target | null {
  const host = d.host.trim();
  const user = d.user.trim();
  const port = d.port.trim() ? Number(d.port) : DEFAULT_PORT[d.proto];
  if (!validHost(host) || !validUser(user) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { proto: d.proto, host, port, user, legacy: d.proto === 'ssh' && d.legacy };
}

export const protoBadge = (p: Proto): string => (p === 'ssh' ? 'SSH' : 'TEL');

/**
 * Remote connections: SSH or Telnet to routers, switches and other servers.
 * Quick connect takes what a person would type after `ssh`; saved connections
 * keep host, port, user and the legacy switch, never a password.
 */
export function ConnectPanel({ list, onChange, onConnect, onClose }: ConnectProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Draft | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) input.current?.focus();
  }, [editing]);

  const quick = parseQuick(query);
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((c) => `${c.name} ${c.proto} ${targetLabel(c)}`.toLowerCase().includes(q)) : list;
  // Row 0 is quick connect when the text reads as a target.
  const rows = (quick ? 1 : 0) + shown.length;
  const at = Math.min(cursor, Math.max(0, rows - 1));

  const go = (t: Target, name = '') => {
    onConnect(t, name);
    onClose();
  };

  const runRow = (i: number) => {
    if (quick && i === 0) go({ ...quick, legacy: quick.proto === 'ssh' && legacy });
    else {
      const c = shown[i - (quick ? 1 : 0)];
      if (c) go(c, c.name);
    }
  };

  if (editing) {
    const t = draftTarget(editing);
    const save = (connect: boolean) => {
      if (!t) return;
      const conn: Conn = { ...t, id: editing.id, name: editing.name.trim().slice(0, 40), used: list.find((c) => c.id === editing.id)?.used ?? Date.now() };
      const exists = list.some((c) => c.id === conn.id);
      onChange(exists ? list.map((c) => (c.id === conn.id ? conn : c)) : [conn, ...list]);
      if (connect) go(conn, conn.name);
      else setEditing(null);
    };
    return (
      <Popover id="connect" label="Edit connection" onClose={onClose} className="tw-pop-conn">
        <form
          className="tw-snip-form tw-conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            save(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(null);
            }
          }}
        >
          <div className="tw-pop-head">{list.some((c) => c.id === editing.id) ? 'Edit connection' : 'New connection'}</div>
          <div className="tw-seg" role="group" aria-label="Protocol">
            {(['ssh', 'telnet'] as const).map((p) => (
              <button key={p} type="button" className={`tw-chip${editing.proto === p ? ' is-on' : ''}`} aria-pressed={editing.proto === p} onClick={() => setEditing({ ...editing, proto: p })}>
                {p === 'ssh' ? 'SSH' : 'Telnet'}
              </button>
            ))}
          </div>
          <label>
            <span>Name</span>
            <input value={editing.name} placeholder="Core router" onChange={(e) => setEditing({ ...editing, name: e.currentTarget.value })} autoFocus />
          </label>
          <div className="tw-conn-grid">
            <label>
              <span>Host</span>
              <input
                value={editing.host}
                placeholder="192.168.88.1"
                spellCheck={false}
                aria-invalid={editing.host !== '' && !validHost(editing.host.trim())}
                onChange={(e) => setEditing({ ...editing, host: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>Port</span>
              <input value={editing.port} inputMode="numeric" placeholder={String(DEFAULT_PORT[editing.proto])} onChange={(e) => setEditing({ ...editing, port: e.currentTarget.value.replace(/\D/g, '').slice(0, 5) })} />
            </label>
          </div>
          <label>
            <span>User {editing.proto === 'telnet' && <small>(telnet asks for it itself)</small>}</span>
            <input
              value={editing.user}
              placeholder={editing.proto === 'ssh' ? 'admin' : 'optional'}
              spellCheck={false}
              autoCapitalize="off"
              aria-invalid={!validUser(editing.user.trim())}
              onChange={(e) => setEditing({ ...editing, user: e.currentTarget.value })}
            />
          </label>
          {editing.proto === 'ssh' && (
            <label className="tw-toggle">
              <span>
                Legacy algorithms
                <small>For old routers: SHA-1 key exchange, ssh-rsa and ssh-dss keys, CBC ciphers</small>
              </span>
              <input type="checkbox" role="switch" checked={editing.legacy} onChange={(e) => setEditing({ ...editing, legacy: e.currentTarget.checked })} />
              <i aria-hidden="true" />
            </label>
          )}
          {editing.proto === 'telnet' && <p className="tw-conn-warn">Telnet sends passwords in clear text. Use it only on a network you trust.</p>}
          <div className="tw-snip-actions">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm" disabled={!t} onClick={() => save(false)}>
              Save
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!t}>
              Save and connect
            </button>
          </div>
        </form>
      </Popover>
    );
  }

  return (
    <Popover id="connect" label="Connect" onClose={onClose} className="tw-pop-conn">
      <div className="tw-snip-top">
        <input
          ref={input}
          className="tw-snip-search"
          placeholder="admin@192.168.88.1  ·  telnet 10.0.0.1 23"
          aria-label="Quick connect or search saved connections"
          value={query}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(rows - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runRow(at);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <button type="button" className="tw-icon-btn" aria-label="New connection" title="New connection" onClick={() => setEditing(blank())}>
          <Icon.plus />
        </button>
      </div>
      <ul className="tw-snips tw-conns" role="listbox" aria-label="Connections">
        {quick && (
          <li role="option" aria-selected={at === 0} className={at === 0 ? 'is-at' : ''} onMouseEnter={() => setCursor(0)}>
            <button type="button" className="tw-snip-main tw-conn-main" onClick={() => runRow(0)}>
              <span className="tw-proto">{protoBadge(quick.proto)}</span>
              <span className="tw-conn-text">
                <span className="tw-snip-label">Connect to {targetLabel(quick)}</span>
                <code>{quick.proto} · port {quick.port}{quick.user ? ` · user ${quick.user}` : ''}</code>
              </span>
            </button>
            {quick.proto === 'ssh' && (
              <button
                type="button"
                className={`tw-chip${legacy ? ' is-on' : ''}`}
                aria-pressed={legacy}
                title="Legacy algorithms for old routers"
                onClick={() => {
                  setLegacy((v) => !v);
                  input.current?.focus();
                }}
              >
                Legacy
              </button>
            )}
          </li>
        )}
        {shown.map((c, j) => {
          const i = j + (quick ? 1 : 0);
          return (
            <li key={c.id} role="option" aria-selected={i === at} className={i === at ? 'is-at' : ''} onMouseEnter={() => setCursor(i)}>
              <button type="button" className="tw-snip-main tw-conn-main" onClick={() => go(c, c.name)} title="Connect (Enter)">
                <span className="tw-proto">{protoBadge(c.proto)}</span>
                <span className="tw-conn-text">
                  <span className="tw-snip-label">{c.name || targetLabel(c)}</span>
                  <code>
                    {c.name ? `${targetLabel(c)} · ` : ''}
                    {c.proto} {c.port}
                    {c.legacy ? ' · legacy' : ''}
                  </code>
                </span>
              </button>
              <span className="tw-snip-tools">
                <button
                  type="button"
                  className="tw-icon-btn is-sm"
                  aria-label={`Edit ${c.name || targetLabel(c)}`}
                  title="Edit"
                  onClick={() => setEditing({ id: c.id, name: c.name, proto: c.proto, host: c.host, port: c.port === DEFAULT_PORT[c.proto] ? '' : String(c.port), user: c.user, legacy: c.legacy })}
                >
                  <Icon.edit />
                </button>
                <button type="button" className="tw-icon-btn is-sm" aria-label={`Forget ${c.name || targetLabel(c)}`} title="Forget" onClick={() => onChange(list.filter((x) => x.id !== c.id))}>
                  <Icon.trash />
                </button>
              </span>
            </li>
          );
        })}
        {rows === 0 && (
          <li className="tw-snip-empty">
            {list.length ? 'No saved connection matches. Type user@host to connect.' : 'Type user@host and press Enter, or add one with +. Connections you open are kept here.'}
          </li>
        )}
      </ul>
      <p className="tw-pop-foot">
        Passwords are typed into the session, never stored. Host keys are learnt on first connect.
      </p>
    </Popover>
  );
}
