import type { JSX } from 'react';
import type { AgentKind, AgentSession } from '../shared/contract';
import type { ChatSignal } from './ChatFab';
import { AgentKindIcon, BotIcon, ChatIcon } from './icons';

interface AgentsCardProps {
  readonly canChat: boolean;
  readonly canShell: boolean;
  readonly chat: ChatSignal;
  readonly agents: readonly AgentSession[];
  /** Hermes service state; null (no stats yet, or no such service) hides its row. */
  readonly hermesOnline: boolean | null;
  readonly onOpenChat: () => void;
  readonly onOpenMenu: () => void;
}

/** Overview card: what each agent is doing now. Reads App's state only, no polling of its own. */
export function AgentsCard({ canChat, canShell, chat, agents, hermesOnline, onOpenChat, onOpenMenu }: AgentsCardProps): JSX.Element | null {
  // Hermes is shown only beside agents the login can use; a viewer gets no card (its status is on the services lamps).
  if (!canChat && !canShell) return null;

  const sessionRow = (kind: AgentKind, label: string): JSX.Element => {
    const mine = agents.filter((s) => s.kind === kind);
    const link = mine.length === 1 ? mine[0]?.link : null;
    return (
      <li className="agents-row" key={kind}>
        <button type="button" className="agents-main" onClick={onOpenMenu}>
          <span className="agents-name">
            <AgentKindIcon kind={kind} size={16} />
            {label}
          </span>
          <span className={`agents-state ${mine.length ? 'is-on' : ''}`}>{mine.length ? `${mine.length} running` : 'none'}</span>
        </button>
        {link && (
          <a className="agents-link" href={link} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>
        )}
      </li>
    );
  };

  return (
    <section className="section" aria-label="Agents">
      <div className="section-head">
        <h2 className="section-title">Agents</h2>
        <span className="section-hint">what they are doing</span>
      </div>
      <ul className="agents-card">
        {canChat && (
          <li className="agents-row">
            <button type="button" className="agents-main" onClick={onOpenChat}>
              <span className="agents-name">
                <ChatIcon size={16} />
                OpenCode
              </span>
              <span className={`agents-state ${chat.asking ? 'is-ask' : chat.busy ? 'is-on' : ''}`}>
                {chat.asking ? 'waiting for your answer' : chat.busy ? 'working' : 'idle'}
              </span>
            </button>
          </li>
        )}
        {canShell && sessionRow('agy', 'agy')}
        {canShell && sessionRow('claude', 'Claude Code')}
        {hermesOnline !== null && (
          <li className="agents-row">
            <div className="agents-main">
              <span className="agents-name">
                <BotIcon size={16} />
                Hermes
              </span>
              <span className={`agents-state ${hermesOnline ? 'is-on' : 'is-off'}`}>{hermesOnline ? 'online' : 'offline'}</span>
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}
