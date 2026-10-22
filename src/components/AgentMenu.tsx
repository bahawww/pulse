import { type JSX, useEffect, useState } from 'react';
import { AGENT_LIMIT, type AgentKind, type AgentSession } from '../shared/contract';
import type { useAgents } from '../hooks/useAgents';
import { copyToClipboard, formatUptime } from '../lib/urls';
import { useNow } from '../hooks/useNow';
import { AgentKindIcon, ChatIcon, CopyIcon, PlusIcon, TerminalIcon } from './icons';

interface AgentMenuProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly canChat: boolean;
  readonly canShell: boolean;
  readonly agents: ReturnType<typeof useAgents>;
  readonly onOpenChat: () => void;
  readonly onOpenTerminal: (name: string) => void;
  readonly onNotify: (msg: string) => void;
}

const LABEL: Record<AgentKind, string> = { agy: 'agy', claude: 'Claude Code' };
const OPEN_LABEL: Record<AgentKind, string> = { agy: 'Open in agy web ↗', claude: 'Open in Claude ↗' };
const KINDS: readonly AgentKind[] = ['agy', 'claude'];

/** Session age; it ticks only while mounted, i.e. while the menu is open. */
function Age({ since }: { since: number }): JSX.Element {
  const now = useNow(30_000);
  return <span className="agent-card-age">{formatUptime((now - since) / 1000)}</span>;
}

/**
 * The round button's menu: the OpenCode chat, new agy / Claude Code sessions,
 * and one card per live session with its remote link. A .pop, so phones get
 * the bottom sheet (lib/sheets.ts). Stays mounted while closed: a start takes
 * up to ~18 s and its spinner and result must survive closing the sheet.
 */
export function AgentMenu({ open, onClose, canChat, canShell, agents, onOpenChat, onOpenTerminal, onNotify }: AgentMenuProps): JSX.Element | null {
  const [starting, setStarting] = useState<ReadonlySet<AgentKind>>(new Set());
  const [stopping, setStopping] = useState<string | null>(null);
  // Stops in flight: their cards are disabled so a second confirm sends nothing.
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const { sessions, listError, refresh, start, stop } = agents;

  useEffect(() => {
    if (!open) {
      setStopping(null);
      return undefined;
    }
    if (canShell) refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, canShell, refresh, onClose]);

  if (!open) return null;

  const begin = async (kind: AgentKind) => {
    setStarting((s) => new Set(s).add(kind));
    const got = await start(kind);
    setStarting((s) => {
      const next = new Set(s);
      next.delete(kind);
      return next;
    });
    onNotify(typeof got === 'string' ? got : got.link ? `${got.name} is ready` : `${got.name} started, no link yet`);
  };

  const end = async (name: string) => {
    setStopping(null);
    if (ending.has(name)) return;
    setEnding((s) => new Set(s).add(name));
    const err = await stop(name);
    setEnding((s) => {
      const next = new Set(s);
      next.delete(name);
      return next;
    });
    onNotify(err ?? `Stopped ${name}`);
  };

  const copy = async (link: string) => onNotify((await copyToClipboard(link)) ? 'Link copied' : 'Could not copy the link');

  const card = (s: AgentSession): JSX.Element => {
    const busy = ending.has(s.name);
    return (
      <li key={s.name} className="agent-card" aria-busy={busy || undefined}>
        <div className="agent-card-head">
          <AgentKindIcon kind={s.kind} size={18} />
          <strong className="agent-card-name">{s.name}</strong>
          <Age since={s.created} />
        </div>
        {s.link ? (
          <a className="btn btn-primary agent-card-open" href={s.link} target="_blank" rel="noopener noreferrer">
            {OPEN_LABEL[s.kind]}
          </a>
        ) : (
          <p className="agent-card-wait">started, no link yet</p>
        )}
        {stopping === s.name ? (
          <div className="agent-card-actions" role="group" aria-label={`Stop ${s.name}?`}>
            <span className="agent-card-ask">
              Stop <strong>{s.name}</strong>? The agent quits.
            </span>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void end(s.name)}>
              Stop
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setStopping(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="agent-card-actions">
            {s.link && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void copy(s.link ?? '')}>
                <CopyIcon size={14} />
                Copy link
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                onClose();
                onOpenTerminal(s.name);
              }}
            >
              <TerminalIcon size={14} />
              Open terminal
            </button>
            <button type="button" className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => setStopping(s.name)}>
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <div className="pop-backdrop" aria-hidden="true" onClick={onClose} />
      <div className="pop agent-pop" role="dialog" aria-label="Agents">
        {canChat && (
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onClose();
              onOpenChat();
            }}
          >
            <ChatIcon size={18} />
            <span className="menu-item-label">Chat OpenCode</span>
          </button>
        )}
        {canShell &&
          KINDS.map((kind) => {
            const busy = starting.has(kind);
            const full = sessions.filter((s) => s.kind === kind).length >= AGENT_LIMIT;
            return (
              <button key={kind} type="button" className="menu-item" disabled={busy || full} aria-busy={busy || undefined} onClick={() => void begin(kind)}>
                {busy ? <span className="agent-spinner" aria-hidden="true" /> : <PlusIcon size={18} />}
                <span className="menu-item-text">
                  <span className="menu-item-label">{busy ? `Starting ${LABEL[kind]}…` : `New ${LABEL[kind]} session`}</span>
                  {full && !busy && <span className="menu-item-hint">{AGENT_LIMIT} running: stop one first</span>}
                </span>
              </button>
            );
          })}
        {canShell && listError && (
          <p className="note is-error" role="alert">
            Cannot list sessions: {listError}
          </p>
        )}
        {canShell && sessions.length > 0 && <ul className="agent-cards">{sessions.map(card)}</ul>}
      </div>
    </>
  );
}
