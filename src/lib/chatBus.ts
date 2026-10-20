import { useSyncExternalStore } from 'react';

/**
 * "Ask the agent" from anywhere in the dashboard. A button calls askAgent();
 * App opens the chat in a new conversation with the question and the host data
 * it names already in the message box (the person sends it). Only logins that
 * may chat see the buttons (useAskEnabled).
 */

/** Host data the server collects for a message (src/server/chatContext.ts). */
export interface ContextRef {
  readonly kind: 'metrics' | 'alerts' | 'disk' | 'logs' | 'diagnose';
  /** A unit (logs) or a service or container (diagnose). */
  readonly name?: string;
  readonly lines?: number;
}

export interface AskRequest {
  readonly prompt: string;
  readonly context?: readonly ContextRef[];
}

let enabled = false;
const listeners = new Set<() => void>();
let handler: ((r: AskRequest) => void) | null = null;

export function setAskEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  for (const l of listeners) l();
}

export function useAskEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => enabled,
  );
}

/** App registers the one handler that opens the chat. */
export function onAsk(h: (r: AskRequest) => void): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function askAgent(r: AskRequest): void {
  handler?.(r);
}
