/**
 * Pure helpers for the agent launcher: session names, trust-prompt answers and
 * takeover-link scraping. No tmux calls here, so they test without a terminal.
 */
import type { AgentKind } from '../shared/contract.js';

/** Allowed agent session names; the charset keeps them safe inside a tmux/shell argument. */
export const AGENT_NAME = /^(agy|cc)-[A-Za-z0-9_-]{1,36}$/;

const PREFIX: Record<AgentKind, string> = { agy: 'agy', claude: 'cc' };

export function agentKindOf(name: string): AgentKind | null {
  if (name.startsWith('agy-')) return 'agy';
  if (name.startsWith('cc-')) return 'claude';
  return null;
}

/** `<prefix>-HHMM`, then `-2`, `-3`... until it is free. */
export function nextName(kind: AgentKind, taken: readonly string[], now: Date): string {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const base = `${PREFIX[kind]}-${hhmm}`;
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

/** Keys that accept the folder-trust prompt, or null when the pane shows no such prompt. */
export function trustKeys(kind: AgentKind, pane: string): readonly string[] | null {
  if (kind === 'agy') return /trust the contents of this project/i.test(pane) ? ['Enter'] : null;
  // Claude's menu starts on "No, exit"; Down moves to "Yes".
  return /Yes, I trust this folder/.test(pane) && /No, exit/.test(pane) ? ['Down', 'Enter'] : null;
}

/** The newest takeover link in pane text or a log; agy logs only carry the id, so rebuild the URL. */
export function findLink(kind: AgentKind, text: string): string | null {
  if (kind === 'claude') {
    return [...text.matchAll(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g)].pop()?.[0] ?? null;
  }
  const hits = [
    ...[...text.matchAll(/https:\/\/antigravity\.google\.com\/r\/[A-Za-z0-9-]+/g)].map((m) => ({ at: m.index, url: m[0] })),
    ...[...text.matchAll(/\[remote-control-([A-Za-z0-9-]+)\]/g)].map((m) => ({ at: m.index, url: `https://antigravity.google.com/r/${m[1]}` })),
  ];
  return hits.sort((a, b) => a.at - b.at).pop()?.url ?? null;
}
