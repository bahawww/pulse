import { type JSX, useEffect, useState } from 'react';
import { sendJson } from '../../lib/csrf';
import { formatAgo } from '../../lib/format';
import type { ActionLogEntry, Runbook, RunbooksBody } from '../../shared/contract';
import { newId } from './model';
import { Icon, Popover } from './panels';

/**
 * Runbooks (server: runbooks.ts). A runbook is a named list of one-line
 * commands. Running one types its steps into the current window one at a
 * time: each command is shown first and runs only on a tap, and the shell's
 * exit code comes back (OSC 777 pulse-step) to mark the step and the history.
 */

/** Per step: not run yet, typed and waiting for the shell, skipped, or its exit code. */
export type StepResult = 'todo' | 'running' | 'skipped' | number;

export interface RunState {
  readonly book: Runbook;
  /** The window the steps go to. */
  readonly win: number;
  readonly results: readonly StepResult[];
}

/** What a step types: the command, then its exit code as an escape the terminal reads back. */
export function stepInput(command: string): string {
  // Leading space: out of bash history (the action log keeps it instead).
  return ` ${command}; printf '\\033]777;pulse-step;%s\\007' $?\r`;
}

/** "label :: command" per line, or just the command. */
function parseSteps(text: string): Runbook['steps'] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const cut = l.indexOf(' :: ');
      return cut < 0 ? { label: '', command: l } : { label: l.slice(0, cut).trim(), command: l.slice(cut + 4).trim() };
    })
    .filter((s) => s.command);
}

const stepsText = (b: Runbook): string => b.steps.map((s) => (s.label ? `${s.label} :: ${s.command}` : s.command)).join('\n');

interface Props {
  readonly run: RunState | null;
  readonly onStart: (book: Runbook) => void;
  readonly onStep: (index: number) => void;
  readonly onSkip: (index: number) => void;
  readonly onStop: () => void;
  readonly onClose: () => void;
}

export function RunbooksPanel({ run, onStart, onStep, onSkip, onStop, onClose }: Props): JSX.Element {
  const [data, setData] = useState<RunbooksBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; steps: string; isNew: boolean } | null>(null);

  const load = () =>
    fetch('/api/runbooks', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (r) => (r.ok ? setData((await r.json()) as RunbooksBody) : setError(`Could not load runbooks (HTTP ${r.status})`)))
      .catch(() => setError('Pulse is unreachable'));

  useEffect(() => {
    void load();
  }, []);

  const save = async (list: readonly Runbook[]) => {
    try {
      const res = await sendJson('PUT', '/api/runbooks', { runbooks: list });
      const got = (await res.json()) as RunbooksBody & { error?: string };
      if (!res.ok) {
        setError(got.error ?? `HTTP ${res.status}`);
        return false;
      }
      setData(got);
      setError(null);
      return true;
    } catch {
      setError('Pulse is unreachable');
      return false;
    }
  };

  // ---- a run in progress
  if (run) {
    const next = run.results.findIndex((r) => r === 'todo');
    const waiting = run.results.includes('running');
    return (
      <Popover id="runbooks" label={`Runbook ${run.book.name}`} onClose={onClose} className="tw-pop-snip tw-pop-run">
        <div className="tw-pop-head">{run.book.name}</div>
        <ol className="tw-run-steps">
          {run.book.steps.map((s, i) => {
            const r = run.results[i] ?? 'todo';
            const state = r === 'todo' ? 'todo' : r === 'running' ? 'running' : r === 'skipped' ? 'skipped' : r === 0 ? 'ok' : 'bad';
            return (
              <li key={i} className={`is-${state}${i === next && !waiting ? ' is-next' : ''}`}>
                <span className="tw-run-label">{s.label || s.command}</span>
                {s.label && <code>{s.command}</code>}
                <span className="tw-run-state">
                  {state === 'running' ? 'running…' : state === 'ok' ? 'done' : state === 'bad' ? `exit ${String(r)}` : state === 'skipped' ? 'skipped' : ''}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="tw-snip-actions">
          <button type="button" className="btn btn-sm" onClick={onStop}>
            {next < 0 && !waiting ? 'Close run' : 'Stop run'}
          </button>
          {next >= 0 && (
            <>
              <button type="button" className="btn btn-sm" disabled={waiting} onClick={() => onSkip(next)}>
                Skip
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={waiting} onClick={() => onStep(next)}>
                Run step {next + 1}
              </button>
            </>
          )}
        </div>
      </Popover>
    );
  }

  // ---- edit or create
  if (editing) {
    const list = data?.runbooks ?? [];
    const steps = parseSteps(editing.steps);
    return (
      <Popover id="runbooks" label="Edit runbook" onClose={onClose} className="tw-pop-snip">
        <form
          className="tw-snip-form"
          onSubmit={(e) => {
            e.preventDefault();
            const book: Runbook = { id: editing.id, name: editing.name.trim(), steps };
            const nextList = editing.isNew ? [...list, book] : list.map((b) => (b.id === book.id ? book : b));
            void save(nextList).then((ok) => ok && setEditing(null));
          }}
        >
          <div className="tw-pop-head">{editing.isNew ? 'New runbook' : 'Edit runbook'}</div>
          <label>
            <span>Name</span>
            <input value={editing.name} maxLength={60} placeholder="Restart the web stack" onChange={(e) => setEditing({ ...editing, name: e.currentTarget.value })} autoFocus />
          </label>
          <label>
            <span>Steps, one per line</span>
            <textarea
              value={editing.steps}
              rows={6}
              spellCheck={false}
              placeholder={'Check disk :: df -h /\nsudo systemctl restart nginx'}
              onChange={(e) => setEditing({ ...editing, steps: e.currentTarget.value })}
            />
          </label>
          <p className="tw-pop-foot">
            <kbd>label :: command</kbd> or just the command. Each step runs only when you tap it.
          </p>
          {error && <p className="note is-error">{error}</p>}
          <div className="tw-snip-actions">
            {!editing.isNew && (
              <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => void save(list.filter((b) => b.id !== editing.id)).then((ok) => ok && setEditing(null))}>
                Delete
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!editing.name.trim() || steps.length === 0}>
              Save
            </button>
          </div>
        </form>
      </Popover>
    );
  }

  // ---- the list and recent runs
  return (
    <Popover id="runbooks" label="Runbooks" onClose={onClose} className="tw-pop-snip">
      <div className="tw-snip-top">
        <div className="tw-pop-head">Runbooks</div>
        <button
          type="button"
          className="tw-icon-btn"
          aria-label="New runbook"
          title="New runbook"
          onClick={() => setEditing({ id: `rb-${newId().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`, name: '', steps: '', isNew: true })}
        >
          <Icon.plus />
        </button>
      </div>
      {error && <p className="note is-error">{error}</p>}
      <ul className="tw-snips" aria-label="Runbooks">
        {!data && !error && <li className="tw-snip-empty">Loading…</li>}
        {data?.runbooks.map((b) => (
          <li key={b.id}>
            <button type="button" className="tw-snip-main" onClick={() => onStart(b)} title="Start: steps run one at a time">
              <span className="tw-snip-label">{b.name}</span>
              <code>
                {b.steps.length} step{b.steps.length === 1 ? '' : 's'} · {b.steps.map((s) => s.label || s.command).join(' → ')}
              </code>
            </button>
            <span className="tw-snip-tools tw-run-tools">
              <button type="button" className="tw-icon-btn is-sm" aria-label={`Edit ${b.name}`} onClick={() => setEditing({ id: b.id, name: b.name, steps: stepsText(b), isNew: false })}>
                <Icon.edit />
              </button>
            </span>
          </li>
        ))}
        {data && data.runbooks.length === 0 && <li className="tw-snip-empty">No runbooks. Add one with +.</li>}
      </ul>
      {data && data.runs.length > 0 && (
        <>
          <div className="tw-pop-head">Recent steps</div>
          <ul className="tw-run-history">
            {data.runs.slice(0, 10).map((a: ActionLogEntry) => (
              <li key={a.id} className={a.ok ? '' : 'is-bad'}>
                <span>
                  <strong>{a.name}</strong> {a.action}
                </span>
                <span className="tw-run-msg">{a.message}</span>
                <span className="tw-run-when">
                  {formatAgo(Date.now() - a.ts)}
                  {a.user ? ` · ${a.user}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}
