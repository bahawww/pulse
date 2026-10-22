import { type JSX, useEffect, useRef, useState } from 'react';
import { sendJson } from '../lib/csrf';
import { formatAgo } from '../lib/format';
import { copyToClipboard } from '../lib/urls';
import type { Clip } from '../shared/contract';
import { ClipboardIcon, CopyIcon, TrashIcon } from './icons';

/**
 * A clipboard shared by this login's devices (server: clipboard.ts). Type or
 * paste text and send it; every device signed in as you sees it while the panel
 * is open (it refreshes every few seconds) and copies it with one tap.
 */

const POLL_MS = 4_000;

/** A short name for this device, shown next to what it sent. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'a device';
}

export function SharedClipboard({ onNotify }: { readonly onNotify: (message: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState<readonly Clip[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // While open: load, then keep it fresh so a clip sent from another device shows up.
  useEffect(() => {
    if (!open) return;
    let stop = false;
    const load = () =>
      fetch('/api/clipboard', { cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(async (r) => {
          if (r.ok && !stop) setClips(((await r.json()) as { clips: Clip[] }).clips);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => !document.hidden && void load(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const call = async (method: 'POST' | 'DELETE', body: object): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await sendJson(method, '/api/clipboard', body);
      const got = (await res.json()) as { clips?: Clip[]; error?: string };
      if (!res.ok || !got.clips) {
        onNotify(got.error ?? 'Clipboard is unavailable');
        return false;
      }
      setClips(got.clips);
      return true;
    } catch {
      onNotify('Pulse is unreachable');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (await call('POST', { text: draft, device: deviceName() })) {
      setDraft('');
      onNotify('Sent to your devices');
    }
  };

  const pasteHere = () =>
    void navigator.clipboard
      ?.readText()
      .then((t) => setDraft(t))
      .catch(() => onNotify('This browser did not allow reading the clipboard; paste into the box instead'));

  const copy = async (c: Clip) => onNotify((await copyToClipboard(c.text)) ? 'Copied' : 'Could not copy');

  return (
    <div className="pop-anchor" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Shared clipboard"
        title="Shared clipboard: send text between your devices"
      >
        <ClipboardIcon size={15} />
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop clip-pop" role="dialog" aria-label="Shared clipboard">
            <div className="card-head" style={{ padding: '4px 4px 8px' }}>
              <h2 className="card-title">Clipboard</h2>
              <span className="card-sub">your devices · kept 24 h</span>
            </div>
            <form
              className="clip-form"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                value={draft}
                rows={3}
                placeholder="Type or paste text to send"
                aria-label="Text to send"
                spellCheck={false}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="clip-actions">
                {typeof navigator.clipboard?.readText === 'function' && (
                  <button type="button" className="btn btn-sm" onClick={pasteHere}>
                    Paste
                  </button>
                )}
                <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !draft.trim()}>
                  Send
                </button>
              </div>
            </form>
            <ul className="clip-list" aria-label="Recent clips">
              {clips === null && <li className="clip-empty">Loading…</li>}
              {clips?.length === 0 && <li className="clip-empty">Nothing yet. Send text from any device signed in as you.</li>}
              {clips?.map((c) => (
                <li key={c.id}>
                  <button type="button" className="clip-text" onClick={() => void copy(c)} title="Copy">
                    {c.text}
                  </button>
                  <span className="clip-meta">
                    {c.device} · {formatAgo(Date.now() - c.ts)}
                  </span>
                  <span className="clip-tools">
                    <button type="button" className="icon-btn" aria-label="Copy" onClick={() => void copy(c)}>
                      <CopyIcon size={14} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Delete" disabled={busy} onClick={() => void call('DELETE', { id: c.id })}>
                      <TrashIcon size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {clips && clips.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm clip-clear" disabled={busy} onClick={() => void call('DELETE', { id: null })}>
                Clear all
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
