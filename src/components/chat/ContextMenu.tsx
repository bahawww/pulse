import { type JSX, useEffect, useState } from 'react';

import { PlusIcon, SearchIcon } from '../icons';
import { contextBlock, fetchContext } from './context';
import type { ContextRef } from '../../lib/chatBus';

/**
 * The "+" in the message box: put host data in the message (a snapshot, alerts,
 * disk usage, a service's logs). It lands as text the person can read and edit
 * before sending; the agent gets nothing it was not shown.
 */

interface ContextMenuProps {
  readonly disabled: boolean;
  /** Receives the finished block to add to the message. */
  readonly onInsert: (block: string) => void;
  readonly onError: (message: string) => void;
  /** On a phone the attach and dictate buttons live in this menu instead of beside it. */
  readonly onAttach?: () => void;
  readonly attachDisabled?: boolean;
  readonly onDictate?: () => void;
  readonly listening?: boolean;
}

const ITEMS: readonly { readonly label: string; readonly hint: string; readonly ref: ContextRef }[] = [
  { label: 'Host snapshot', hint: 'CPU, memory, disks, top processes, containers', ref: { kind: 'metrics' } },
  { label: 'Alerts', hint: 'what is firing, and what resolved lately', ref: { kind: 'alerts' } },
  { label: 'Disk usage', hint: 'filesystems and Docker space', ref: { kind: 'disk' } },
];

export function ContextMenu({ disabled, onInsert, onError, onAttach, attachDisabled = false, onDictate, listening = false }: ContextMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'root' | 'logs'>('root');
  const [units, setUnits] = useState<readonly string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    setStep('root');
    setQ('');
  };

  const take = async (ref: ContextRef) => {
    setBusy(true);
    try {
      onInsert(contextBlock(await fetchContext(ref)));
      close();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'could not get that');
    } finally {
      setBusy(false);
    }
  };

  const openLogs = () => {
    setStep('logs');
    if (units) return;
    void fetch('/api/logs/units', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((b: { units?: string[] }) => setUnits(b.units ?? []))
      .catch(() => setUnits([]));
  };

  const needle = q.trim().toLowerCase();
  return (
    <div className="pop-anchor chat-ctx">
      <button
        type="button"
        className={`chat-ctx-btn${listening ? ' is-live' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add to the message"
        title="Add a file, host info or your voice to the message"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <PlusIcon size={15} />
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={close} />
          <div className="pop chat-ctx-pop" role="menu" aria-label="Add host info">
            {step === 'root' ? (
              <>
                {onAttach && (
                  <button type="button" role="menuitem" className="menu-item phone-only" disabled={attachDisabled} onClick={() => { close(); onAttach(); }}>
                    <span className="menu-item-text">
                      <span className="menu-item-label">Attach a file</span>
                      <span className="menu-item-hint">an image or a text file</span>
                    </span>
                  </button>
                )}
                {onDictate && (
                  <button type="button" role="menuitem" className="menu-item phone-only" onClick={() => { close(); onDictate(); }}>
                    <span className="menu-item-text">
                      <span className="menu-item-label">{listening ? 'Stop dictation' : 'Dictate'}</span>
                      <span className="menu-item-hint">{listening ? 'listening now' : 'speak instead of typing'}</span>
                    </span>
                  </button>
                )}
                {ITEMS.map((i) => (
                  <button key={i.label} type="button" role="menuitem" className="menu-item" disabled={busy} onClick={() => void take(i.ref)}>
                    <span className="menu-item-text">
                      <span className="menu-item-label">{i.label}</span>
                      <span className="menu-item-hint">{i.hint}</span>
                    </span>
                  </button>
                ))}
                <button type="button" role="menuitem" className="menu-item" disabled={busy} onClick={openLogs}>
                  <span className="menu-item-text">
                    <span className="menu-item-label">Service logs…</span>
                    <span className="menu-item-hint">the last 80 lines of a unit</span>
                  </span>
                </button>
              </>
            ) : (
              <>
                <label className="chat-model-search">
                  <SearchIcon size={14} />
                  <input autoFocus={!window.matchMedia('(pointer: coarse)').matches} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services" aria-label="Search services" />
                </label>
                <div className="chat-model-list">
                  {units === null && <p className="chat-muted">Loading…</p>}
                  {units
                    ?.filter((u) => u.toLowerCase().includes(needle))
                    .slice(0, 80)
                    .map((u) => (
                      <button key={u} type="button" role="menuitem" className="menu-item" disabled={busy} onClick={() => void take({ kind: 'logs', name: u, lines: 80 })}>
                        <span className="menu-item-label">{u}</span>
                      </button>
                    ))}
                  {units && units.length > 0 && !units.some((u) => u.toLowerCase().includes(needle)) && <p className="chat-muted">No service matches.</p>}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
