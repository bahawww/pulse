import { useCallback, useMemo } from 'react';
import type { AgentKind, AgentSession } from '../shared/contract';
import { postJson } from '../lib/csrf';
import { usePolled } from './usePolled';

interface AgentsBody {
  readonly sessions?: readonly AgentSession[];
  readonly error?: string;
}

const NONE: readonly AgentSession[] = [];

/** Reads an API answer: the error text on failure, else the body. */
async function answer<T>(res: Response): Promise<T | string> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  return res.ok ? body : (body.error ?? `HTTP ${res.status}`);
}

/**
 * The agy and Claude Code sessions, shared by the agent menu and the Home card.
 * Slow poll: sessions start and stop through this hook, which refreshes after each.
 */
export function useAgents(enabled: boolean) {
  const { data, refresh } = usePolled<AgentsBody>('/api/agents/sessions', 30_000, enabled);

  /** The new session, or the error text. Can take ~18 s: the server waits for the link. */
  const start = useCallback(
    async (kind: AgentKind): Promise<AgentSession | string> => {
      try {
        const got = await answer<{ session?: AgentSession }>(await postJson('/api/agents/sessions', { kind }));
        return typeof got === 'string' ? got : (got.session ?? 'No session in the answer');
      } catch {
        return 'Pulse is unreachable';
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  /** null when stopped, else the error text. */
  const stop = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        const got = await answer<{ ok?: boolean }>(await postJson('/api/agents/sessions/stop', { name }));
        return typeof got === 'string' ? got : null;
      } catch {
        return 'Pulse is unreachable';
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const sessions = data?.sessions ?? NONE;
  return useMemo(() => ({ sessions, refresh, start, stop }), [sessions, refresh, start, stop]);
}
