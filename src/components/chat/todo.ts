import type { ChatMessage } from '../../shared/contract';

export interface Todo {
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

/** The `todos` input of an agent's todowrite call (JSON text), or null when it is not a usable list. */
export function parseTodos(raw: string | undefined): Todo[] | null {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return null;
    const out: Todo[] = [];
    for (const t of list) {
      const item = t as { content?: unknown; status?: unknown };
      if (typeof item?.content !== 'string') return null;
      out.push({ content: item.content, status: STATUS.has(String(item.status)) ? (item.status as Todo['status']) : 'pending' });
    }
    return out;
  } catch {
    return null;
  }
}

/** The agent's plan for the current turn: the last todowrite call since the last prompt (an older turn's plan is not this one's). */
export function latestTodos(messages: readonly ChatMessage[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return null;
    const parts = messages[i]!.parts;
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const p = parts[j]!;
      if (p.type === 'tool' && p.tool === 'todowrite') {
        const todos = parseTodos(p.input.todos);
        if (todos) return todos;
      }
    }
  }
  return null;
}

/** The tool call running right now, if any (the last message's). */
export function runningTool(messages: readonly ChatMessage[]): { tool: string; title: string } | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  for (let j = last.parts.length - 1; j >= 0; j -= 1) {
    const p = last.parts[j]!;
    if (p.type === 'tool' && (p.status === 'running' || p.status === 'pending')) return { tool: p.tool, title: p.title };
  }
  return null;
}
