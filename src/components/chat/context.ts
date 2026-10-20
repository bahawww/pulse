import type { AskRequest, ContextRef } from '../../lib/chatBus';

export interface HostContext {
  readonly title: string;
  readonly text: string;
}

/** Host data from the server (redacted there), to drop into a message. */
export async function fetchContext(ref: ContextRef): Promise<HostContext> {
  const qs = new URLSearchParams({ kind: ref.kind });
  if (ref.name) qs.set('name', ref.name);
  if (ref.lines) qs.set('lines', String(ref.lines));
  const res = await fetch(`/api/chat/context?${qs.toString()}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as { title?: string; text?: string; error?: string };
  if (!res.ok || typeof body.text !== 'string') throw new Error(body.error ?? `could not get ${ref.kind} (${res.status})`);
  return { title: body.title ?? ref.kind, text: body.text };
}

/** A fenced block with a heading; the fence is longer than any run of backticks inside. */
export function contextBlock(c: HostContext): string {
  const longest = Math.max(0, ...[...c.text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${c.title}:\n${fence}text\n${c.text}\n${fence}`;
}

/** The message an ask becomes: the question, then each block of host data. */
export async function resolveAsk(req: AskRequest): Promise<string> {
  const blocks = await Promise.all((req.context ?? []).map(fetchContext));
  return [req.prompt, ...blocks.map(contextBlock)].join('\n\n');
}

/** The /diagnose, /why-slow, /disk-hog and /explain-alert messages. */
export const TEMPLATES: Readonly<Record<string, (args: string) => AskRequest>> = {
  diagnose: (name) => ({
    prompt: `Diagnose "${name}". Read its status and recent logs below, find the most likely cause of trouble, and suggest the smallest safe fix. Ask me before you change anything.`,
    context: [{ kind: 'diagnose', name }],
  }),
  'why-slow': () => ({
    prompt: 'The server feels slow. From this snapshot, find what is using CPU, memory or disk I/O, or what is causing pressure, and tell me what to do first.',
    context: [{ kind: 'metrics' }],
  }),
  'disk-hog': () => ({
    prompt: 'The disk looks full. Find what is using the most space (largest directories first, then Docker data) and tell me what is safe to clean. Do not delete anything without asking me.',
    context: [{ kind: 'disk' }],
  }),
  'explain-alert': () => ({
    prompt: 'Explain these alerts: what each one means, the most likely cause on this server, and what to check first.',
    context: [{ kind: 'alerts' }, { kind: 'metrics' }],
  }),
};
