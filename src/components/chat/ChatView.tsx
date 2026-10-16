import { type FormEvent, type JSX, type KeyboardEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import '../../chat.css';
import type { ChatMessage, ChatModelRef, ChatPermission, ChatProviderList, ChatSession, ChatUpstream } from '../../shared/contract';
import { formatAgo } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/motion';
import type { ChatSignal } from '../ChatFab';
import { ConfirmDialog } from '../ConfirmDialog';
import { ArrowDownIcon, CheckIcon, ChatIcon, ChevronDownIcon, ListIcon, MinimizeIcon, MoreIcon, PencilIcon, PlusIcon, RefreshIcon, SearchIcon, SendIcon, StopIcon, TrashIcon } from '../icons';
import { Markdown } from './Markdown';
import { PermissionCard, ToolCard } from './Parts';
import { type Chat, useChat } from './useChat';

/**
 * The chat: talk to the OpenCode agent on this box, full screen over the
 * dashboard (opened from ChatFab). Sessions live in OpenCode (the :4096 web UI
 * shows the same ones). Wide screens show the session list beside the thread;
 * below 900px it is a menu, a bottom sheet on phones.
 */

const UPSTREAM_TEXT: Readonly<Record<Exclude<ChatUpstream, 'up'>, { title: string; hint: string }>> = {
  down: { title: 'OpenCode is not running', hint: 'Start it with systemctl --user start opencode-web, then retry.' },
  auth: { title: 'OpenCode refused the login', hint: 'The password in ~/.config/opencode/web.env does not match the running server.' },
  unconfigured: { title: 'OpenCode is not set up for Pulse', hint: 'Pulse could not read ~/.config/opencode/web.env.' },
};

function dirLabel(dir: string, home: string): string {
  if (dir === home) return '';
  return dir.replace(/^\/home\/[^/]+/, '~');
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

interface ListProps {
  readonly chat: Chat;
  readonly onPick: () => void;
}

/** New chat, then one row per session. Rename and delete live in the open chat's menu. */
function SessionList({ chat, onPick }: ListProps): JSX.Element {
  const now = Date.now();
  return (
    <>
      <button
        type="button"
        className="btn chat-new"
        onClick={() => {
          chat.open(null);
          onPick();
        }}
      >
        <PlusIcon size={15} />
        New chat
      </button>
      <div className="chat-sessions" role="list">
        {chat.sessions === null && <p className="chat-muted">{chat.upstream === 'up' || chat.upstream === 'loading' ? 'Loading…' : 'Chats show here once OpenCode is back.'}</p>}
        {chat.sessions?.length === 0 && <p className="chat-muted">No chats yet.</p>}
        {chat.sessions?.map((s) => (
          <div key={s.id} role="listitem" className={`chat-session${s.id === chat.currentId ? ' is-current' : ''}`}>
            <button
              type="button"
              className="chat-session-main"
              aria-current={s.id === chat.currentId ? 'true' : undefined}
              onClick={() => {
                chat.open(s.id);
                onPick();
              }}
            >
              <span className="chat-session-title">
                {s.busy && <span className="chat-busy-dot" aria-label="working" />}
                {s.title || 'Untitled'}
              </span>
              <span className="chat-session-meta">
                {formatAgo(now - s.updatedAt)}
                {dirLabel(s.directory, chat.directory) && <span className="chat-dir">{dirLabel(s.directory, chat.directory)}</span>}
              </span>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

function modelName(list: ChatProviderList | null, m: ChatModelRef): string {
  const p = list?.providers.find((x) => x.id === m.providerID);
  return p?.models.find((x) => x.id === m.modelID)?.name ?? m.modelID;
}

function ModelPicker({ chat }: { readonly chat: Chat }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const effective = chat.model ?? chat.current?.model ?? null;
  const label = effective ? modelName(chat.providers, effective) : 'Default model';

  useEffect(() => {
    if (!open) return;
    // Phones: no keyboard over the sheet until the search is tapped.
    if (!window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (chat.providers?.providers ?? [])
      .map((p) => ({
        ...p,
        models: needle ? p.models.filter((m) => `${p.name} ${m.name} ${m.id}`.toLowerCase().includes(needle)) : p.models,
      }))
      .filter((p) => p.models.length > 0);
  }, [chat.providers, q]);

  const pick = (m: ChatModelRef | null) => {
    chat.setModel(m);
    setOpen(false);
    setQ('');
  };
  const isOn = (pid: string, mid: string) => effective?.providerID === pid && effective.modelID === mid;

  return (
    <div className="pop-anchor chat-model">
      <button type="button" className="chat-model-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={effective ? `${effective.providerID}/${effective.modelID}` : 'The agent picks its default'}>
        <span>{label}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop chat-model-pop" role="listbox" aria-label="Model">
            <label className="chat-model-search">
              <SearchIcon size={14} />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" />
            </label>
            <div className="chat-model-list">
              {!q && (
                <button type="button" role="option" aria-selected={chat.model === null} className={`menu-item${chat.model === null ? ' is-selected' : ''}`} onClick={() => pick(null)}>
                  <CheckIcon className="menu-check" size={14} />
                  <span className="menu-item-text">
                    <span className="menu-item-label">Session default</span>
                    <span className="menu-item-hint">{chat.current?.model ? modelName(chat.providers, chat.current.model) : 'what OpenCode is set to'}</span>
                  </span>
                </button>
              )}
              {chat.providers === null && <p className="chat-muted">Loading models…</p>}
              {groups.map((p) => (
                <div key={p.id} className="chat-model-group">
                  <div className="chat-model-provider">{p.name}</div>
                  {p.models.slice(0, q ? 60 : 400).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isOn(p.id, m.id)}
                      className={`menu-item${isOn(p.id, m.id) ? ' is-selected' : ''}`}
                      onClick={() => pick({ providerID: p.id, modelID: m.id })}
                    >
                      <CheckIcon className="menu-check" size={14} />
                      <span className="menu-item-label">{m.name}</span>
                    </button>
                  ))}
                </div>
              ))}
              {q && groups.length === 0 && <p className="chat-muted">No model matches.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

const Message = memo(function Message({
  message,
  permissions,
  onAnswer,
}: {
  readonly message: ChatMessage;
  readonly permissions: readonly ChatPermission[];
  readonly onAnswer: (p: ChatPermission, reply: 'once' | 'always' | 'reject') => Promise<void>;
}): JSX.Element | null {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
    const files = message.parts.filter((p) => p.type === 'file');
    if (!text && files.length === 0) return null;
    return (
      <div className="chat-msg is-user">
        <div className="chat-bubble">
          {text}
          {files.map((f) => f.type === 'file' && <span key={f.id} className="chat-file">{f.filename}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-msg is-assistant">
      {message.parts.map((p) => {
        switch (p.type) {
          case 'text':
            return p.text.trim() ? <Markdown key={p.id} text={p.text} /> : null;
          case 'reasoning':
            return p.text.trim() ? (
              <details key={p.id} className="chat-reasoning">
                <summary>Thinking</summary>
                <div className="chat-reasoning-body">{p.text}</div>
              </details>
            ) : null;
          case 'file':
            return (
              <span key={p.id} className="chat-file">
                {p.filename}
              </span>
            );
          case 'tool': {
            const ask = permissions.find((x) => x.callID && x.callID === p.callID);
            return (
              <div key={p.id} className="chat-tool-wrap">
                <ToolCard part={p} asking={!!ask} />
                {ask && <PermissionCard permission={ask} onAnswer={(r) => onAnswer(ask, r)} />}
              </div>
            );
          }
          default:
            return null;
        }
      })}
      {message.error && <div className={`chat-msg-error${message.error === 'Stopped' ? ' is-stopped' : ''}`}>{message.error}</div>}
    </div>
  );
});

function Thread({ chat }: { readonly chat: Chat }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const t = chat.thread;

  // Permissions whose tool card is not on screen (another message, or no call id).
  const shownCalls = useMemo(() => new Set(t?.messages.flatMap((m) => m.parts.map((p) => (p.type === 'tool' ? p.callID : '')))), [t?.messages]);
  const loose = t?.permissions.filter((p) => !p.callID || !shownCalls.has(p.callID)) ?? [];

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAway(!near);
  };

  // Follow the reply while the reader is at the bottom; leave them be once they scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    stick.current = true;
    setAway(false);
  }, [chat.currentId]);

  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const empty = !t || (t.messages.length === 0 && !chat.pending);
  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-thread">
        {empty && !chat.loadingThread && (
          <div className="chat-empty">
            <span className="chat-empty-glyph">
              <ChatIcon size={22} />
            </span>
            <h3>What should the agent do?</h3>
            <p>
              OpenCode works in <code>{chat.current?.directory || chat.directory || '~'}</code>. It asks before it runs a command or changes a file.
            </p>
          </div>
        )}
        {empty && chat.loadingThread && <p className="chat-muted chat-loading">Loading conversation…</p>}
        {t?.messages.map((m) => (
          <Message key={m.id} message={m} permissions={t.permissions} onAnswer={chat.answer} />
        ))}
        {chat.pending && (
          <div className="chat-msg is-user is-pending">
            <div className="chat-bubble">{chat.pending}</div>
          </div>
        )}
        {loose.map((p) => (
          <PermissionCard key={p.id} permission={p} onAnswer={(r) => chat.answer(p, r)} />
        ))}
        {(t?.busy || chat.pending) && (
          <div className="chat-working" aria-live="polite">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {t?.retry ? `Retrying: ${t.retry}` : t?.permissions.length ? 'Waiting for your answer' : 'Working'}
          </div>
        )}
        {t?.error && <div className="chat-msg-error">{t.error}</div>}
      </div>
      {away && (
        <button type="button" className="chat-jump" onClick={toBottom} aria-label="Jump to latest">
          <ArrowDownIcon size={14} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({ chat, disabled, active }: { readonly chat: Chat; readonly disabled: boolean; readonly active: boolean }): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = !!chat.thread?.busy;

  // Grows with the text up to a cap, then scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Keyboard users type at once; on touch the keyboard waits for a tap.
  useEffect(() => {
    if (active && !window.matchMedia('(pointer: coarse)').matches) ref.current?.focus();
  }, [chat.currentId, active]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    setText('');
    chat
      .send(value)
      .catch(() => setText((t) => t || value))
      .finally(() => setSending(false));
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on a keyboard; on touch it is a new line (the button sends).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) submit();
  };

  return (
    <form className="chat-composer" onSubmit={submit}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={disabled ? 'OpenCode is unavailable' : 'Message OpenCode'}
        aria-label="Message"
        disabled={disabled}
        maxLength={100_000}
      />
      <div className="chat-composer-bar">
        <ModelPicker chat={chat} />
        {busy && !text.trim() ? (
          <button type="button" className="chat-send is-stop" onClick={() => void chat.abort()} aria-label="Stop">
            <StopIcon size={14} />
          </button>
        ) : (
          <button type="submit" className="chat-send" disabled={!text.trim() || sending || disabled} aria-label="Send">
            <SendIcon size={16} />
          </button>
        )}
      </div>
    </form>
  );
}

/** One button for what can be done to the open chat. */
function ChatMenu({ onRename, onDelete }: { readonly onRename: () => void; readonly onDelete: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="pop-anchor">
      <button type="button" className="chat-icon-btn" aria-label="Chat options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreIcon size={17} />
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop chat-menu-pop" role="menu">
            <button type="button" role="menuitem" className="menu-item" onClick={pick(onRename)}>
              <PencilIcon size={15} />
              <span className="menu-item-label">Rename</span>
            </button>
            <button type="button" role="menuitem" className="menu-item chat-menu-danger" onClick={pick(onDelete)}>
              <TrashIcon size={15} />
              <span className="menu-item-label">Delete</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** Matches chat-overlay-out in chat.css. */
const EXIT_MS = 200;

interface ChatViewProps {
  /** Shown full screen; false keeps it mounted and hidden, still following its sessions. */
  readonly open: boolean;
  readonly onMinimize: () => void;
  readonly onNotify: (text: string) => void;
  /** Busy and waiting-for-answer, for the floating button while minimized. */
  readonly onSignal: (signal: ChatSignal) => void;
}

/**
 * The chat, full screen like ChatGPT: the session list beside the thread on
 * wide screens, a sheet below 900px. Opened from the floating button
 * (ChatFab); Minimize (or the back button) returns to the dashboard. Nothing
 * stops when it is minimized: it stays mounted, its stream keeps following
 * the agent, and OpenCode runs the session on its own anyway.
 */
export function ChatView({ open, onMinimize, onNotify, onSignal }: ChatViewProps): JSX.Element {
  const chat = useChat(onNotify);
  const rootRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'open' | 'closing' | 'hidden'>(open ? 'open' : 'hidden');
  const [listOpen, setListOpen] = useState(false);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const up = chat.upstream === 'up' || chat.upstream === 'loading';
  const status = chat.upstream !== 'up' && chat.upstream !== 'loading' ? UPSTREAM_TEXT[chat.upstream] : null;

  // Open at once; leave with a short animation, then hide (still mounted).
  useEffect(() => {
    if (open) {
      setPhase('open');
      return undefined;
    }
    setPhase((p) => (p === 'hidden' || prefersReducedMotion() ? 'hidden' : 'closing'));
    const t = window.setTimeout(() => setPhase('hidden'), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  // The page behind does not scroll while the chat covers it.
  useEffect(() => {
    if (phase === 'hidden') return undefined;
    document.documentElement.dataset.chatOpen = '';
    return () => void delete document.documentElement.dataset.chatOpen;
  }, [phase]);

  // Phones: follow the visual viewport, so the on-screen keyboard does not cover the composer.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = rootRef.current;
    if (!open || !vv || !el) return undefined;
    const sync = () => {
      el.style.setProperty('--chat-h', `${vv.height}px`);
      el.style.setProperty('--chat-top', `${vv.offsetTop}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [open]);

  const busy = !!chat.thread?.busy || !!chat.sessions?.some((s) => s.busy);
  const asking = (chat.thread?.permissions.length ?? 0) > 0;
  useEffect(() => {
    onSignal({ busy, asking });
  }, [busy, asking, onSignal]);

  const list = <SessionList chat={chat} onPick={() => setListOpen(false)} />;

  const commitRename = () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (title) void chat.rename(renaming.id, title);
    setRenaming(null);
  };

  return (
    <div ref={rootRef} className="chat-overlay" data-phase={phase} role="dialog" aria-modal="true" aria-label="Chat" aria-hidden={phase === 'hidden'}>
      <div className="chat">
        <aside className="chat-side" aria-label="Chats">
          {list}
        </aside>

        <section className="chat-main" aria-label="Conversation">
          <header className="chat-head">
            <div className="pop-anchor chat-list-anchor">
              <button type="button" className="chat-icon-btn chat-list-btn" aria-label="Chats" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
                <ListIcon size={18} />
              </button>
              {listOpen && (
                <>
                  <div className="pop-backdrop" aria-hidden="true" onClick={() => setListOpen(false)} />
                  <div className="pop chat-list-pop" aria-label="Chats">
                    {list}
                  </div>
                </>
              )}
            </div>
            {renaming ? (
              <form
                className="chat-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  commitRename();
                }}
              >
                <input
                  autoFocus
                  value={renaming.title}
                  maxLength={200}
                  aria-label="Chat title"
                  onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                />
              </form>
            ) : (
              <h3 className="chat-title">{chat.current?.title || (chat.currentId ? 'Chat' : 'New chat')}</h3>
            )}
            {/* Only when something is wrong; connected needs no badge. */}
            {chat.upstream !== 'up' && (
              <span className={`chat-upstream is-${chat.upstream}`} title={status?.hint}>
                <span className="chat-upstream-dot" aria-hidden="true" />
                {chat.upstream === 'loading' ? 'Connecting' : chat.upstream === 'auth' ? 'Auth failed' : 'Offline'}
              </span>
            )}
            {chat.current && !renaming && (
              <ChatMenu
                onRename={() => setRenaming({ id: chat.current!.id, title: chat.current!.title })}
                onDelete={() => setDeleting(chat.current)}
              />
            )}
            <button type="button" className="chat-icon-btn chat-minimize" onClick={onMinimize} aria-label="Minimize, back to the dashboard" title="Minimize">
              <MinimizeIcon size={18} />
            </button>
          </header>

          {status && (
            <div className="chat-status" role="status">
              <div>
                <strong>{status.title}</strong>
                <span>{status.hint}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={chat.retry}>
                <RefreshIcon size={14} />
                Retry
              </button>
            </div>
          )}

          <Thread chat={chat} />
          <Composer chat={chat} disabled={!up} active={open} />
        </section>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        icon="delete"
        title="Delete this chat?"
        message={`"${deleting?.title ?? ''}" and its history are removed from OpenCode, also from its own web UI.`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const s = deleting;
          setDeleting(null);
          if (s) void chat.remove(s.id);
        }}
      />
    </div>
  );
}
