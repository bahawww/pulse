import { type JSX, memo, useState } from 'react';

import type { ChatMessage, ChatPermission, ChatToolPart } from '../../shared/contract';
import { CheckIcon, ChevronDownIcon, FileIcon, PencilIcon, SearchIcon, TerminalIcon } from '../icons';
import { type Todo, latestTodos, parseTodos, runningTool } from './todo';

/** A unified diff, one line per row, added and removed lines tinted. */
export function DiffView({ diff }: { readonly diff: string }): JSX.Element {
  const rows = diff.split('\n').filter((l) => !/^(Index:|={5,}|diff --git|index [0-9a-f])/.test(l));
  return (
    <pre className="chat-diff">
      {rows.map((l, i) => {
        const kind = l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        return (
          <span key={i} className={kind ? `is-${kind}` : undefined}>
            {l || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

/** The agent's plan as a checklist. */
export function TodoList({ todos }: { readonly todos: readonly Todo[] }): JSX.Element {
  return (
    <ul className="chat-todos">
      {todos.map((t, i) => (
        <li key={i} className={`is-${t.status}`}>
          <span className="chat-todo-mark" aria-hidden="true">
            {t.status === 'completed' ? <CheckIcon size={11} /> : t.status === 'in_progress' ? <span className="chat-spinner" /> : null}
          </span>
          <span className="chat-todo-text">{t.content}</span>
          <span className="chat-sr">{t.status.replace('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Above the composer while the agent works: its plan (todowrite) with a count,
 * and the call running now. Gone once the plan is done and the agent idle.
 */
export function Progress({ messages, busy }: { readonly messages: readonly ChatMessage[]; readonly busy: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(true);
  const todos = latestTodos(messages);
  const running = busy ? runningTool(messages) : null;
  const done = todos ? todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length : 0;
  const current = todos?.find((t) => t.status === 'in_progress');
  const finished = !!todos && done === todos.length;
  if ((!todos || (finished && !busy)) && !running) return null;
  return (
    <div className="chat-progress" role="status">
      <button type="button" className="chat-progress-head" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!todos}>
        <span className="chat-progress-title">
          {todos ? `Progress ${done}/${todos.length}` : 'Working'}
          {current && <span className="chat-progress-now"> · {current.content}</span>}
        </span>
        {running && (
          <span className="chat-progress-run">
            <span className="chat-spinner" aria-hidden="true" />
            {running.tool}
          </span>
        )}
        {todos && <ChevronDownIcon className="chat-tool-chev" size={14} />}
      </button>
      {open && todos && <TodoList todos={todos} />}
    </div>
  );
}

function ToolGlyph({ tool }: { readonly tool: string }): JSX.Element {
  if (tool === 'bash') return <TerminalIcon size={14} />;
  if (tool === 'edit' || tool === 'write' || tool === 'patch' || tool === 'apply_patch') return <PencilIcon size={14} />;
  if (tool === 'grep' || tool === 'glob' || tool === 'list' || tool === 'webfetch' || tool === 'websearch') return <SearchIcon size={14} />;
  return <FileIcon size={14} />;
}

const STATUS_LABEL: Readonly<Record<ChatToolPart['status'], string>> = {
  pending: 'waiting',
  running: 'running',
  completed: 'done',
  error: 'failed',
};

/** What the input shows for tools whose title already says it. */
const SHOWN_AS_TITLE = new Set(['command', 'filePath', 'description']);

/** A tool call: the command or file in the header, input, output and diff inside. */
export const ToolCard = memo(function ToolCard({ part, asking }: { readonly part: ChatToolPart; readonly asking: boolean }): JSX.Element {
  // Opens by itself while it waits for an answer or failed, so the reason is in view.
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (asking || (part.status === 'error' && part.error !== 'Stopped'));
  const command = part.tool === 'bash' ? part.input.command : undefined;
  const todos = part.tool === 'todowrite' ? parseTodos(part.input.todos) : null;
  const extra = Object.entries(part.input).filter(([k, v]) => v && !SHOWN_AS_TITLE.has(k) && !(part.tool === 'write' && k === 'content') && !(todos && k === 'todos'));
  // A stopped call is not a failure: no red.
  const tone = part.error === 'Stopped' ? 'stopped' : part.status;
  const hasBody = !!(command || todos || extra.length || part.output || part.error || part.diff || (part.tool === 'write' && part.input.content));
  return (
    <div className={`chat-tool is-${tone}${asking ? ' is-asking' : ''}${shown ? ' is-open' : ''}`}>
      <button type="button" className="chat-tool-head" aria-expanded={shown} onClick={() => setOpen(!shown)} disabled={!hasBody}>
        <span className="chat-tool-glyph">
          <ToolGlyph tool={part.tool} />
        </span>
        <span className="chat-tool-name">{part.tool}</span>
        <span className="chat-tool-title">{part.title}</span>
        <span className={`chat-tool-status is-${tone}`}>
          {part.status === 'running' || part.status === 'pending' ? <span className="chat-spinner" aria-hidden="true" /> : part.status === 'completed' ? <CheckIcon size={12} /> : null}
          {asking ? 'needs approval' : part.error === 'Stopped' ? 'stopped' : /rejected permission/i.test(part.error) ? 'denied' : STATUS_LABEL[part.status]}
        </span>
        {hasBody && <ChevronDownIcon className="chat-tool-chev" size={14} />}
      </button>
      {shown && hasBody && (
        <div className="chat-tool-body">
          {command && <pre className="chat-tool-cmd">$ {command}</pre>}
          {todos && <TodoList todos={todos} />}
          {extra.map(([k, v]) => (
            <div key={k} className="chat-tool-field">
              <span>{k}</span>
              <code>{v}</code>
            </div>
          ))}
          {part.diff ? (
            <DiffView diff={part.diff} />
          ) : (
            part.tool === 'write' && part.input.content && <pre className="chat-tool-out">{part.input.content}</pre>
          )}
          {part.output && <pre className="chat-tool-out">{part.output}</pre>}
          {part.error && <pre className="chat-tool-out is-error">{part.error}</pre>}
        </div>
      )}
    </div>
  );
});

const KIND_LABEL: Readonly<Record<string, string>> = {
  bash: 'Run a shell command',
  edit: 'Change a file',
  webfetch: 'Fetch a web page',
  external_directory: 'Work outside the project folder',
  doom_loop: 'Repeat the same call again',
};

/** The agent waits for this: Allow once, Always (for the patterns it names), or Deny. */
export function PermissionCard({ permission, onAnswer }: { readonly permission: ChatPermission; readonly onAnswer: (reply: 'once' | 'always' | 'reject') => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<'once' | 'always' | 'reject' | null>(null);
  const answer = (reply: 'once' | 'always' | 'reject') => {
    setBusy(reply);
    void onAnswer(reply).finally(() => setBusy(null));
  };
  return (
    <div className="chat-perm" role="alertdialog" aria-label="The agent asks for permission">
      <div className="chat-perm-head">
        <span className="chat-perm-dot" aria-hidden="true" />
        <strong>{KIND_LABEL[permission.kind] ?? `Allow ${permission.kind}`}</strong>
      </div>
      {permission.patterns.length > 0 && <pre className="chat-perm-what">{permission.patterns.join('\n')}</pre>}
      {permission.diff && <DiffView diff={permission.diff} />}
      <div className="chat-perm-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => answer('once')}>
          Allow
        </button>
        {permission.always.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() => answer('always')}
            title={`Allow from now on: ${permission.always.join(', ')}`}
          >
            Always allow <code>{permission.always.join(', ')}</code>
          </button>
        )}
        <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy !== null} onClick={() => answer('reject')}>
          Deny
        </button>
      </div>
    </div>
  );
}
