import { type JSX, memo, useState } from 'react';

import type { ChatPermission, ChatToolPart } from '../../shared/contract';
import { CheckIcon, ChevronDownIcon, FileIcon, PencilIcon, SearchIcon, TerminalIcon } from '../icons';

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
  const extra = Object.entries(part.input).filter(([k, v]) => v && !SHOWN_AS_TITLE.has(k) && !(part.tool === 'write' && k === 'content'));
  // A stopped call is not a failure: no red.
  const tone = part.error === 'Stopped' ? 'stopped' : part.status;
  const hasBody = !!(command || extra.length || part.output || part.error || part.diff || (part.tool === 'write' && part.input.content));
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
