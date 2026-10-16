import { type JSX, useLayoutEffect } from 'react';
import { ChatIcon } from './icons';

/** What the hidden chat reports for its button. */
export interface ChatSignal {
  /** A session is working. */
  readonly busy: boolean;
  /** The agent waits for Allow or Deny. */
  readonly asking: boolean;
}

interface ChatFabProps {
  readonly signal: ChatSignal;
  /** The chat is open over it. Kept mounted so the tab bar keeps its place. */
  readonly hidden?: boolean;
  readonly onOpen: () => void;
  /** Starts fetching the chat's code on intent (hover, a finger landing). */
  readonly onWarm?: () => void;
}

/**
 * The chat's button, floating at the bottom right: on phones beside the tab
 * bar (same height and glass), on desktop in the corner. Opens the chat full
 * screen. While the chat is minimized it keeps running: a ring while the agent
 * works, a badge while it waits for an answer. html[data-chat-fab] lets the
 * tab bar and the terminal's resume button make room (mobile.css, styles.css).
 */
export function ChatFab({ signal, hidden = false, onOpen, onWarm }: ChatFabProps): JSX.Element {
  useLayoutEffect(() => {
    document.documentElement.dataset.chatFab = '';
    return () => void delete document.documentElement.dataset.chatFab;
  }, []);

  const label = signal.asking ? 'Chat: OpenCode is waiting for your answer' : signal.busy ? 'Chat: OpenCode is working' : 'Open chat';
  return (
    <button
      type="button"
      className={`chat-fab${signal.busy ? ' is-busy' : ''}${signal.asking ? ' is-asking' : ''}${hidden ? ' is-hidden' : ''}`}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      onClick={onOpen}
      onPointerDown={onWarm}
      onMouseEnter={onWarm}
      aria-label={label}
      title={label}
    >
      <ChatIcon size={24} />
      {signal.busy && !signal.asking && <span className="chat-fab-ring" aria-hidden="true" />}
      {signal.asking && (
        <span className="chat-fab-badge" aria-hidden="true">
          !
        </span>
      )}
    </button>
  );
}
