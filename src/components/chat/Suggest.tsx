import { type JSX, useEffect, useRef } from 'react';

import type { ChatCommand, ChatFileHit, ChatSubagent } from '../../shared/contract';
import { BotIcon, FileIcon, FolderIcon, TerminalIcon } from '../icons';

/**
 * "/" and "@" in the composer, as in the OpenCode TUI:
 *  - "/" at the start of the message: commands. Pulse's own (what the TUI
 *    does itself: /new, /models, /undo ...) and the agent's (GET /command:
 *    /init, /review, custom commands, MCP prompts, skills).
 *  - "@" anywhere: a subagent (@general hands the task over) or a file or
 *    folder, whose content goes along with the message.
 */

/** Commands Pulse runs itself, the TUI's built-ins. `session`: needs an open chat. */
export const BUILTIN_COMMANDS = [
  { name: 'new', description: 'Start a new chat', session: false },
  { name: 'sessions', description: 'Open another chat', session: false },
  { name: 'models', description: 'Pick the model', session: false },
  { name: 'context', description: 'Context window and token usage of this chat', session: true },
  { name: 'auto', description: 'Auto mode: run every command and edit without asking (off by default)', session: false },
  { name: 'rename', description: 'Rename this chat (/rename new title)', session: true },
  { name: 'compact', description: 'Summarize the chat so far to free up context', session: true },
  { name: 'undo', description: 'Take back the last message and its file changes', session: true },
  { name: 'redo', description: 'Bring back what /undo took', session: true },
  { name: 'share', description: 'Make a public link to this chat', session: true },
  { name: 'unshare', description: 'Remove the public link', session: true },
] as const;

export type BuiltinName = (typeof BUILTIN_COMMANDS)[number]['name'];

/** The TUI's other names for the same thing. */
export const BUILTIN_ALIASES: Readonly<Record<string, BuiltinName>> = {
  summarize: 'compact',
  clear: 'new',
  session: 'sessions',
  model: 'models',
  usage: 'context',
  cost: 'context',
  tokens: 'context',
};

export type Suggestion =
  | { readonly kind: 'builtin'; readonly name: BuiltinName; readonly description: string }
  | { readonly kind: 'command'; readonly command: ChatCommand }
  | { readonly kind: 'agent'; readonly agent: ChatSubagent }
  | { readonly kind: 'file'; readonly file: ChatFileHit };

/** What the caret is in: the command name after a leading "/", or an "@" word. */
export interface Trigger {
  readonly kind: 'slash' | 'mention';
  /** Where the trigger character sits. */
  readonly start: number;
  /** Typed after it, up to the caret. */
  readonly query: string;
}

export function findTrigger(text: string, caret: number): Trigger | null {
  if (text.startsWith('/')) {
    const space = text.search(/\s/);
    if (space < 0 || caret <= space) return { kind: 'slash', start: 0, query: text.slice(1, caret) };
  }
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  if (text[start] === '@') return { kind: 'mention', start, query: text.slice(start + 1, caret) };
  return null;
}

/** Contains the query; names that start with it first. */
function rank<T>(items: readonly T[], name: (t: T) => string, query: string): T[] {
  const q = query.toLowerCase();
  return items
    .filter((t) => name(t).toLowerCase().includes(q))
    .sort((a, b) => Number(!name(a).toLowerCase().startsWith(q)) - Number(!name(b).toLowerCase().startsWith(q)));
}

export function slashSuggestions(query: string, commands: readonly ChatCommand[], hasSession: boolean): Suggestion[] {
  const own = BUILTIN_COMMANDS.filter((c) => hasSession || !c.session);
  const taken = new Set<string>(own.map((c) => c.name));
  return [
    ...rank(own, (c) => c.name, query).map((c): Suggestion => ({ kind: 'builtin', name: c.name, description: c.description })),
    ...rank(
      commands.filter((c) => !taken.has(c.name)),
      (c) => c.name,
      query,
    ).map((c): Suggestion => ({ kind: 'command', command: c })),
  ];
}

export function agentSuggestions(query: string, agents: readonly ChatSubagent[]): Suggestion[] {
  return rank(agents, (a) => a.name, query).map((a) => ({ kind: 'agent', agent: a }));
}

function label(s: Suggestion): string {
  switch (s.kind) {
    case 'builtin':
      return `/${s.name}`;
    case 'command':
      return `/${s.command.name}`;
    case 'agent':
      return `@${s.agent.name}`;
    case 'file':
      return s.file.path;
  }
}

function detail(s: Suggestion): string {
  switch (s.kind) {
    case 'builtin':
      return s.description;
    case 'command':
      return s.command.description;
    case 'agent':
      return s.agent.description;
    case 'file':
      return '';
  }
}

function Glyph({ s }: { readonly s: Suggestion }): JSX.Element {
  if (s.kind === 'agent') return <BotIcon size={15} />;
  if (s.kind === 'file') return s.file.dir ? <FolderIcon size={15} /> : <FileIcon size={15} />;
  return <TerminalIcon size={14} />;
}

interface SuggestListProps {
  readonly items: readonly Suggestion[];
  readonly active: number;
  /** Changes with what is typed: a new list starts at its top. */
  readonly resetKey: string;
  readonly loading: boolean;
  readonly empty: string;
  readonly onPick: (s: Suggestion) => void;
  readonly onHover: (i: number) => void;
}

/** The list above the composer. Keys stay in the textarea (aria-activedescendant). */
export function SuggestList({ items, active, resetKey, loading, empty, onPick, onHover }: SuggestListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the arrow keys only. Running this on every render (the items are a new
  // array each time a chat event arrives) pulled a list being scrolled by finger
  // back to the active row.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resetKey]);

  return (
    <div className="chat-suggest" role="listbox" id="chat-suggest" ref={listRef} aria-label="Suggestions">
      {items.length === 0 && <p className="chat-suggest-empty">{loading ? 'Searching…' : empty}</p>}
      {items.map((s, i) => {
        const head = i === 0 || items[i - 1]!.kind !== s.kind ? HEADINGS[s.kind] : null;
        return (
          <div key={`${s.kind}:${label(s)}`}>
            {head && <div className="chat-suggest-head">{head}</div>}
            <button
              type="button"
              role="option"
              id={`chat-suggest-${i}`}
              data-index={i}
              aria-selected={i === active}
              className={`chat-suggest-item${i === active ? ' is-active' : ''}`}
              // Keep the textarea focused: pick on mousedown, before blur.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
              // A mouse moving over a row picks it; a finger scrolling must not.
              onPointerMove={(e) => {
                if (e.pointerType === 'mouse' && i !== active) onHover(i);
              }}
            >
              <span className="chat-suggest-glyph">
                <Glyph s={s} />
              </span>
              <span className="chat-suggest-label">{label(s)}</span>
              {s.kind === 'command' && s.command.source !== 'command' && <span className="chat-suggest-badge">{s.command.source}</span>}
              <span className="chat-suggest-detail">{detail(s)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

const HEADINGS: Readonly<Record<Suggestion['kind'], string>> = {
  builtin: 'Pulse',
  command: 'OpenCode',
  agent: 'Agents',
  file: 'Files',
};
