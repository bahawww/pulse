import type { JSX } from 'react';
import { type AskRequest, askAgent, useAskEnabled } from '../lib/chatBus';
import { ChatIcon } from './icons';

interface AskAgentButtonProps extends AskRequest {
  readonly label?: string;
  readonly title?: string;
  /** Icon only, for tight rows. */
  readonly compact?: boolean;
  /** Runs first (to close a popover, say). */
  readonly onAsk?: () => void;
}

/** Opens the chat with this question and host data ready to send. Nothing for logins that may not chat. */
export function AskAgentButton({ prompt, context, label = 'Ask agent', title, compact = false, onAsk }: AskAgentButtonProps): JSX.Element | null {
  const enabled = useAskEnabled();
  if (!enabled) return null;
  return (
    <button
      type="button"
      className={`btn btn-sm ${compact ? 'btn-icon' : 'btn-ghost btn-collapse'}`}
      title={title ?? 'Open the chat with this question and the data it needs; you review it before sending'}
      aria-label={label}
      onClick={() => {
        onAsk?.();
        askAgent({ prompt, context });
      }}
    >
      <ChatIcon size={14} />
      {!compact && <span className="btn-label">{label}</span>}
    </button>
  );
}
