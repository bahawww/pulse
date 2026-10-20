import { type FormEvent, type JSX, type KeyboardEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import '../../chat.css';
import type { ChatFileHit, ChatMention, ChatMessage, ChatModelRef, ChatPermission, ChatProviderList, ChatSession, ChatTokens, ChatUpstream } from '../../shared/contract';
import { formatAgo, formatTokens, formatUsd } from '../../lib/format';
import { prefersReducedMotion } from '../../lib/motion';
import type { ChatSignal } from '../ChatFab';
import { ConfirmDialog } from '../ConfirmDialog';
import { ArrowDownIcon, BellIcon, CheckIcon, ChatIcon, ChevronDownIcon, CopyIcon, ListIcon, MinimizeIcon, MoreIcon, PencilIcon, PlusIcon, RefreshIcon, SearchIcon, SendIcon, StopIcon, TrashIcon } from '../icons';
import { copyText } from './clip';
import { Markdown } from './Markdown';
import { notifyEnabled, notifySupported, setNotifyEnabled, showAlert, vibrate } from './notify';
import { BUILTIN_ALIASES, BUILTIN_COMMANDS, type BuiltinName, type Suggestion, SuggestList, agentSuggestions, findTrigger, slashSuggestions } from './Suggest';
import { PermissionCard, Progress, ToolCard } from './Parts';
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

/** Open state lives in the composer, so /models can open it. */
function ModelPicker({ chat, open, setOpen }: { readonly chat: Chat; readonly open: boolean; readonly setOpen: (open: boolean) => void }): JSX.Element {
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
  }, [open, setOpen]);

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
      <button type="button" className="chat-model-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title={effective ? `${effective.providerID}/${effective.modelID}` : 'The agent picks its default'}>
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

interface MessageActions {
  readonly copy: (m: ChatMessage) => void;
  readonly edit: (m: ChatMessage) => void;
  readonly retry: () => void;
}

/** The text of a message: what was typed, or what the agent wrote (not its thinking). */
function messageText(m: ChatMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();
}

/** A file part not named as @path in the text is an attachment (it cannot be sent again). */
function hasAttachments(m: ChatMessage): boolean {
  const text = messageText(m);
  return m.parts.some((p) => p.type === 'file' && !text.includes(`@${p.filename}`));
}

/** The @file mentions of a sent message, to send them again. */
function mentionsOf(m: ChatMessage): ChatMention[] {
  const text = messageText(m);
  return m.parts.flatMap((p) => (p.type === 'file' && text.includes(`@${p.filename}`) ? [{ type: 'file' as const, value: p.filename }] : []));
}

/** Copy, edit and try again, under a message; visible on hover, always on touch. */
function MessageBar({ message, canEdit, canRetry, actions }: { readonly message: ChatMessage; readonly canEdit: boolean; readonly canRetry: boolean; readonly actions: MessageActions }): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const hasText = messageText(message).length > 0;
  if (!hasText && !canRetry) return null;
  return (
    <div className="chat-actions">
      {hasText && (
        <button
          type="button"
          className="chat-act"
          aria-label="Copy message"
          title="Copy"
          onClick={() => {
            actions.copy(message);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      )}
      {canEdit && hasText && (
        <button
          type="button"
          className="chat-act"
          aria-label="Edit and send again"
          title={hasAttachments(message) ? 'Edit and send again (attachments are not carried over)' : 'Edit and send again'}
          onClick={() => actions.edit(message)}
        >
          <PencilIcon size={13} />
        </button>
      )}
      {canRetry && (
        <button type="button" className="chat-act" aria-label="Try again" title="Try again" onClick={actions.retry}>
          <RefreshIcon size={13} />
        </button>
      )}
    </div>
  );
}

const Message = memo(function Message({
  message,
  permissions,
  onAnswer,
  idle,
  canRetry,
  actions,
}: {
  readonly message: ChatMessage;
  readonly permissions: readonly ChatPermission[];
  readonly onAnswer: (p: ChatPermission, reply: 'once' | 'always' | 'reject') => Promise<void>;
  /** Nothing is running: edit and retry make sense. */
  readonly idle: boolean;
  /** The last reply of the chat, and the prompt it answers can be sent again. */
  readonly canRetry: boolean;
  readonly actions: MessageActions;
}): JSX.Element | null {
  if (message.role === 'user') {
    const text = messageText(message);
    // Files named in the text as @path are marked there; only the others get a chip.
    const files = message.parts.filter((p) => p.type === 'file' && !text.includes(`@${p.filename}`));
    if (!text && files.length === 0) return null;
    return (
      <div className="chat-msg is-user">
        <UserBubble text={text}>
          {files.map((f) => f.type === 'file' && <span key={f.id} className="chat-file">{f.filename}</span>)}
        </UserBubble>
        {idle && <MessageBar message={message} canEdit canRetry={false} actions={actions} />}
      </div>
    );
  }
  const finished = message.completedAt !== null || message.error !== '';
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
      {finished && idle && <MessageBar message={message} canEdit={false} canRetry={canRetry} actions={actions} />}
    </div>
  );
});

/** Above this a prompt (a command's or skill's whole template) is folded. */
const FOLD_CHARS = 700;

/** A prompt as typed: @mentions marked, a long one folded. */
function UserBubble({ text, children }: { readonly text: string; readonly children?: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > FOLD_CHARS;
  const shown = long && !open ? `${text.slice(0, FOLD_CHARS).trimEnd()}…` : text;
  const pieces = shown.split(/(@[^\s]+)/g);
  return (
    <div className="chat-bubble">
      {pieces.map((piece, i) => (i % 2 === 1 ? <span key={i} className="chat-mention">{piece}</span> : piece))}
      {children}
      {long && (
        <button type="button" className="chat-fold" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** What the open chat shows: after /undo the reverted messages stay in OpenCode until /redo or the next prompt. */
function visibleMessages(chat: Chat): readonly ChatMessage[] {
  const t = chat.thread;
  const revert = chat.current?.revertMessageID ?? null;
  return t ? (revert ? t.messages.filter((m) => m.id < revert) : t.messages) : [];
}

function Thread({ chat, onFill, onNotify }: { readonly chat: Chat; readonly onFill: (text: string) => void; readonly onNotify: (text: string) => void }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const t = chat.thread;
  const messages = visibleMessages(chat);
  const undone = t ? t.messages.length - messages.length : 0;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const { undo, send } = chat;
  const actions = useMemo<MessageActions>(
    () => ({
      copy: (m) => void copyText(messageText(m)).then((ok) => ok || onNotify('Could not copy')),
      edit: (m) =>
        void undo(m.id).then((text) => {
          if (text !== null) onFill(text);
        }),
      retry: () => {
        const user = [...messagesRef.current].reverse().find((m) => m.role === 'user');
        if (!user) return;
        const mentions = mentionsOf(user);
        void undo(user.id).then((text) => (text ? send(text, mentions).catch(() => undefined) : undefined));
      },
    }),
    [undo, send, onFill, onNotify],
  );
  const idle = !t?.busy && !chat.pending;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant');

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

  const empty = !t || (messages.length === 0 && !chat.pending && undone === 0);
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
        {messages.map((m) => (
          <Message key={m.id} message={m} permissions={t!.permissions} onAnswer={chat.answer} idle={idle} canRetry={m === lastReply && !!lastUser && !hasAttachments(lastUser)} actions={actions} />
        ))}
        {undone > 0 && (
          <div className="chat-undone">
            {undone === 1 ? '1 message' : `${undone} messages`} undone · <code>/redo</code> brings {undone === 1 ? 'it' : 'them'} back
          </div>
        )}
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

interface ComposerProps {
  readonly chat: Chat;
  readonly disabled: boolean;
  readonly active: boolean;
  readonly onNotify: (text: string) => void;
  /** /sessions */
  readonly onSessions: () => void;
  /** /rename with no title: the header's rename field. */
  readonly onRename: () => void;
  /** /context */
  readonly onUsage: () => void;
  /** /auto and the Auto button: ChatView asks before turning it on. */
  readonly onAuto: () => void;
  /** Text to put in the box (Edit on a message); `n` changes each time. */
  readonly fill: { readonly text: string; readonly n: number } | null;
}

/** "@value" as a whole word in `text` (not the start of a longer path). */
function hasToken(text: string, value: string): boolean {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${esc}(?=\\s|$)`).test(text);
}

function Composer({ chat, disabled, active, onNotify, onSessions, onRename, onUsage, onAuto, fill }: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState(0);
  const [files, setFiles] = useState<{ readonly query: string; readonly hits: readonly ChatFileHit[] } | null>(null);
  const mentions = useRef<ChatMention[]>([]);
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

  const trigger = disabled ? null : findTrigger(text, caret);
  const triggerAt = trigger ? `${trigger.kind}:${trigger.start}` : '';
  const triggerKey = trigger ? `${triggerAt}:${trigger.query}` : '';
  // Escape hides the list until this trigger is gone (another one, or none).
  const shown = !!trigger && hidden !== triggerAt;
  useEffect(() => setActiveItem(0), [triggerKey]);
  useEffect(() => setHidden((h) => (h === triggerAt ? h : null)), [triggerAt]);

  // Files for @, a moment after typing stops.
  const mentionQuery = trigger?.kind === 'mention' ? trigger.query : null;
  const { findFiles } = chat;
  useEffect(() => {
    if (mentionQuery === null) return undefined;
    let alive = true;
    const t = window.setTimeout(() => {
      void findFiles(mentionQuery).then((hits) => {
        if (alive) setFiles({ query: mentionQuery, hits });
      });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [mentionQuery, findFiles]);

  const loading = mentionQuery !== null && files?.query !== mentionQuery;
  const items: Suggestion[] = !shown
    ? []
    : trigger.kind === 'slash'
      ? slashSuggestions(trigger.query, chat.commands, !!chat.currentId)
      : [
          ...agentSuggestions(trigger.query, chat.subagents),
          ...(files?.query === mentionQuery ? files.hits.map((f): Suggestion => ({ kind: 'file', file: f })) : []),
        ];
  // A "/" with nothing to offer is just text ("/etc/hosts is ..."); "@" says what it is doing.
  const listOpen = shown && (items.length > 0 || trigger.kind === 'mention');

  const put = (next: string, pos = next.length) => {
    setText(next);
    setCaret(pos);
    window.requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  // Edit on a message: its text comes back into the box, the caret at the end.
  const fillN = fill?.n;
  useEffect(() => {
    if (fill) put(fill.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillN]);

  const runBuiltin = async (name: BuiltinName, args: string) => {
    switch (name) {
      case 'new':
        chat.open(null);
        return;
      case 'sessions':
        onSessions();
        return;
      case 'models':
        setPickerOpen(true);
        return;
      case 'context':
        onUsage();
        return;
      case 'auto':
        onAuto();
        return;
      case 'rename':
        if (args && chat.currentId) await chat.rename(chat.currentId, args.slice(0, 200));
        else onRename();
        return;
      case 'compact':
        await chat.compact();
        return;
      case 'undo': {
        const back = await chat.undo();
        if (back !== null) put(back);
        return;
      }
      case 'redo':
        await chat.redo();
        return;
      case 'share': {
        const url = await chat.share();
        if (!url) return;
        await navigator.clipboard?.writeText(url).catch(() => undefined);
        onNotify(`Public link copied: ${url}`);
        return;
      }
      case 'unshare':
        await chat.unshare();
        return;
    }
  };

  const pick = (s: Suggestion) => {
    if (!trigger) return;
    const before = text.slice(0, trigger.start);
    const after = text.slice(caret);
    const insert = (value: string) => put(before + value + after, (before + value).length);
    switch (s.kind) {
      case 'builtin':
        put('');
        void runBuiltin(s.name, '');
        return;
      case 'command':
        // One that takes text waits for it; the rest runs now.
        if (s.command.args) insert(`/${s.command.name} `);
        else {
          put('');
          void chat.runCommand(s.command.name, '');
        }
        return;
      case 'agent':
        mentions.current.push({ type: 'agent', value: s.agent.name });
        insert(`@${s.agent.name} `);
        return;
      case 'file':
        mentions.current.push({ type: 'file', value: s.file.path });
        // A folder stays open, to go on into it.
        insert(s.file.dir ? `@${s.file.path}` : `@${s.file.path} `);
        return;
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || sending || disabled) return;
    const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
    if (slash) {
      const typed = slash[1]!;
      const args = (slash[2] ?? '').trim();
      const name = BUILTIN_ALIASES[typed] ?? typed;
      const builtin = BUILTIN_COMMANDS.find((c) => c.name === name && (!!chat.currentId || !c.session));
      if (builtin) {
        put('');
        void runBuiltin(builtin.name, args);
        return;
      }
      const command = chat.commands.find((c) => c.name === typed);
      if (command) {
        put('');
        setSending(true);
        void chat.runCommand(command.name, args).finally(() => setSending(false));
        return;
      }
    }
    const used = mentions.current.filter((m, i, all) => hasToken(value, m.value) && all.findIndex((o) => o.value === m.value) === i);
    mentions.current = [];
    setSending(true);
    put('');
    chat
      .send(value, used)
      .catch(() => setText((t) => t || value))
      .finally(() => setSending(false));
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveItem((a) => (a + step + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        pick(items[Math.min(activeItem, items.length - 1)]!);
        return;
      }
    }
    if (listOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setHidden(triggerAt);
      return;
    }
    // Enter sends on a keyboard; on touch it is a new line (the button sends).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className={`chat-composer${chat.auto ? ' is-auto' : ''}`} onSubmit={submit}>
      {listOpen && (
        <SuggestList
          items={items}
          resetKey={triggerKey}
          active={Math.min(activeItem, Math.max(0, items.length - 1))}
          loading={loading}
          empty={trigger.kind === 'mention' ? 'No agent or file matches' : 'No command matches'}
          onPick={pick}
          onHover={setActiveItem}
        />
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setHidden(triggerAt)}
        onFocus={() => setHidden(null)}
        onKeyDown={onKey}
        placeholder={disabled ? 'OpenCode is unavailable' : 'Message OpenCode · / commands · @ files and agents'}
        aria-label="Message"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listOpen ? 'chat-suggest' : undefined}
        aria-activedescendant={listOpen && items.length > 0 ? `chat-suggest-${Math.min(activeItem, items.length - 1)}` : undefined}
        disabled={disabled}
        maxLength={100_000}
      />
      <div className="chat-composer-bar">
        <div className="chat-composer-tools">
          <ModelPicker chat={chat} open={pickerOpen} setOpen={setPickerOpen} />
          {chat.current && !chat.current.asks && !chat.auto ? (
            <span className="chat-auto is-default" title="Made outside Pulse with OpenCode's defaults: it runs commands without asking anyway.">
              No approval
            </span>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={chat.auto}
              className={`chat-auto${chat.auto ? ' is-on' : ''}`}
              onClick={onAuto}
              title={chat.auto ? 'Auto mode is on: commands and edits run without asking. Click to turn off.' : 'Auto mode: let OpenCode run commands and edits without asking'}
            >
              <span className="chat-auto-switch" aria-hidden="true" />
              Auto
            </button>
          )}
        </div>
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

// ---------------------------------------------------------------------------
// Context and usage
// ---------------------------------------------------------------------------

interface Usage {
  /** Tokens in the context now: everything the last reply read and wrote. */
  readonly context: number;
  /** The model's window, 0 when unknown. */
  readonly limit: number;
  readonly model: ChatModelRef | null;
  readonly last: ChatTokens;
  readonly total: ChatTokens;
  readonly cost: number;
  readonly replies: number;
}

const NO_TOKENS: ChatTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

/** Like the OpenCode TUI: the context is the last reply's input + output + reasoning + cache. */
function usageOf(messages: readonly ChatMessage[], providers: ChatProviderList | null): Usage | null {
  const replies = messages.filter((m) => m.role === 'assistant' && m.tokens);
  const last = [...replies].reverse().find((m) => m.tokens && m.tokens.input + m.tokens.output + m.tokens.cacheRead > 0);
  if (!last?.tokens) return null;
  const t = last.tokens;
  const total = replies.reduce<ChatTokens>(
    (acc, m) => ({
      input: acc.input + m.tokens!.input,
      output: acc.output + m.tokens!.output,
      reasoning: acc.reasoning + m.tokens!.reasoning,
      cacheRead: acc.cacheRead + m.tokens!.cacheRead,
      cacheWrite: acc.cacheWrite + m.tokens!.cacheWrite,
    }),
    NO_TOKENS,
  );
  const model = last.model;
  const limit = model ? (providers?.providers.find((p) => p.id === model.providerID)?.models.find((m) => m.id === model.modelID)?.context ?? 0) : 0;
  return {
    context: t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite,
    limit,
    model,
    last: t,
    total,
    cost: replies.reduce((acc, m) => acc + m.cost, 0),
    replies: replies.length,
  };
}

function TokenRows({ t }: { readonly t: ChatTokens }): JSX.Element {
  return (
    <dl className="chat-usage-grid">
      <dt>Input</dt>
      <dd>{formatTokens(t.input)}</dd>
      <dt>Output</dt>
      <dd>{formatTokens(t.output)}</dd>
      <dt>Reasoning</dt>
      <dd>{formatTokens(t.reasoning)}</dd>
      <dt>Cache read</dt>
      <dd>{formatTokens(t.cacheRead)}</dd>
      <dt>Cache write</dt>
      <dd>{formatTokens(t.cacheWrite)}</dd>
    </dl>
  );
}

/** Header button (a ring filling with the context) and its panel; /context opens it too. */
function UsageButton({ usage, providers, open, setOpen }: { readonly usage: Usage; readonly providers: ChatProviderList | null; readonly open: boolean; readonly setOpen: (open: boolean) => void }): JSX.Element {
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
  }, [open, setOpen]);

  const share = usage.limit > 0 ? Math.min(1, usage.context / usage.limit) : 0;
  const pct = Math.round(share * 100);
  const tone = share >= 0.9 ? 'is-crit' : share >= 0.7 ? 'is-warn' : '';
  const R = 7;
  const C = 2 * Math.PI * R;
  return (
    <div className="pop-anchor">
      <button
        type="button"
        className={`chat-usage-btn ${tone}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={usage.limit ? `Context ${formatTokens(usage.context)} of ${formatTokens(usage.limit)} tokens` : `Context ${formatTokens(usage.context)} tokens`}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={R} className="chat-usage-track" />
          <circle cx="9" cy="9" r={R} className="chat-usage-fill" strokeDasharray={`${C * share} ${C}`} transform="rotate(-90 9 9)" />
        </svg>
        <span>{usage.limit ? `${pct}%` : formatTokens(usage.context)}</span>
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop chat-usage-pop" role="dialog" aria-label="Context and usage">
            <div className="chat-usage-title">Context</div>
            <div className={`chat-usage-bar ${tone}`}>
              <span style={{ transform: `scaleX(${share})` }} />
            </div>
            <p className="chat-usage-line">
              {formatTokens(usage.context)}
              {usage.limit ? ` of ${formatTokens(usage.limit)} tokens · ${pct}% used` : ' tokens (window size unknown)'}
            </p>
            {usage.model && <p className="chat-usage-model">{modelName(providers, usage.model)} · {usage.model.providerID}</p>}
            <div className="chat-usage-title">Last reply</div>
            <TokenRows t={usage.last} />
            <div className="chat-usage-title">
              This chat · {usage.replies} {usage.replies === 1 ? 'reply' : 'replies'}
            </div>
            <TokenRows t={usage.total} />
            <dl className="chat-usage-grid">
              <dt>Cost</dt>
              <dd>{formatUsd(usage.cost)}</dd>
            </dl>
            <p className="chat-usage-hint">
              Near the limit? <code>/compact</code> summarizes the chat so far.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

interface ChatMenuProps {
  /** A chat is open: rename and delete apply. */
  readonly hasChat: boolean;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  /** Alerts (notification, tab mark, vibration) while the chat is out of sight; absent where the browser has none. */
  readonly alerts?: { readonly on: boolean; readonly toggle: () => void };
}

/** One button for what can be done to the open chat, and the chat settings. */
function ChatMenu({ hasChat, onRename, onDelete, alerts }: ChatMenuProps): JSX.Element {
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
            {hasChat && (
              <button type="button" role="menuitem" className="menu-item" onClick={pick(onRename)}>
                <PencilIcon size={15} />
                <span className="menu-item-label">Rename</span>
              </button>
            )}
            {alerts && (
              <button type="button" role="menuitemcheckbox" aria-checked={alerts.on} className="menu-item" onClick={pick(alerts.toggle)}>
                <BellIcon size={15} />
                <span className="menu-item-label">Alerts when away</span>
                <span className={`chat-menu-state${alerts.on ? ' is-on' : ''}`}>{alerts.on ? 'On' : 'Off'}</span>
              </button>
            )}
            {hasChat && (
              <button type="button" role="menuitem" className="menu-item chat-menu-danger" onClick={pick(onDelete)}>
                <TrashIcon size={15} />
                <span className="menu-item-label">Delete</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Alerts for a chat the person is not looking at (minimized, or another tab):
 * a notification, a vibration and a "(!)" in the tab title when the agent needs
 * an answer, and a notification when a chat finishes. Off until switched on.
 */
function useChatAlerts(chat: Chat, open: boolean, enabled: boolean): void {
  const [seen, setSeen] = useState(() => !document.hidden);
  useEffect(() => {
    const onVis = () => setSeen(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const watching = open && seen;

  const asking = (chat.thread?.permissions.length ?? 0) > 0;
  const wasAsking = useRef(false);
  const title = chat.current?.title || 'Chat';
  const currentId = chat.currentId;
  useEffect(() => {
    if (asking && !wasAsking.current && enabled && !watching) {
      void showAlert('OpenCode needs your answer', title, `ask-${currentId ?? ''}`);
      vibrate([180, 80, 180]);
    }
    wasAsking.current = asking;
  }, [asking, enabled, watching, title, currentId]);

  // The tab says so even with no notification permission.
  useEffect(() => {
    if (!asking || watching) return undefined;
    const base = document.title;
    document.title = `(!) ${base}`;
    return () => {
      document.title = base;
    };
  }, [asking, watching]);

  const before = useRef<ReadonlyMap<string, string> | null>(null);
  const { sessions } = chat;
  useEffect(() => {
    if (!sessions) return;
    const now = new Map(sessions.filter((x) => x.busy).map((x) => [x.id, x.title] as const));
    const was = before.current;
    before.current = now;
    if (!was || !enabled || watching) return;
    for (const [id, name] of was) {
      if (!now.has(id) && sessions.some((x) => x.id === id)) {
        void showAlert('OpenCode finished', name || 'Chat', `done-${id}`);
        vibrate(120);
      }
    }
  }, [sessions, enabled, watching]);
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
  const [usageOpen, setUsageOpen] = useState(false);
  const [askAuto, setAskAuto] = useState(false);
  const [fill, setFill] = useState<{ text: string; n: number } | null>(null);
  const onFill = useCallback((text: string) => setFill((f) => ({ text, n: (f?.n ?? 0) + 1 })), []);
  const [alertsOn, setAlertsOn] = useState(notifyEnabled);
  useChatAlerts(chat, open, alertsOn);
  const toggleAlerts = () => {
    void setNotifyEnabled(!alertsOn).then((on) => {
      setAlertsOn(on);
      onNotify(on ? 'Chat alerts are on' : alertsOn ? 'Chat alerts are off' : 'The browser blocked notifications for this site');
    });
  };
  // Turning auto mode on asks first; off is at once.
  const toggleAuto = () => {
    if (chat.auto) void chat.setAuto(false);
    else setAskAuto(true);
  };
  const usage = useMemo(() => {
    const revert = chat.current?.revertMessageID;
    const msgs = chat.thread?.messages ?? [];
    return usageOf(revert ? msgs.filter((m) => m.id < revert) : msgs, chat.providers);
  }, [chat.thread?.messages, chat.current?.revertMessageID, chat.providers]);
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
            {chat.current && !renaming && usage && <UsageButton usage={usage} providers={chat.providers} open={usageOpen} setOpen={setUsageOpen} />}
            {!renaming && (
              <ChatMenu
                hasChat={!!chat.current}
                onRename={() => chat.current && setRenaming({ id: chat.current.id, title: chat.current.title })}
                onDelete={() => setDeleting(chat.current)}
                alerts={notifySupported() ? { on: alertsOn, toggle: toggleAlerts } : undefined}
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

          <Thread chat={chat} onFill={onFill} onNotify={onNotify} />
          <Progress messages={visibleMessages(chat)} busy={!!chat.thread?.busy} />
          <Composer
            chat={chat}
            disabled={!up}
            active={open}
            onNotify={onNotify}
            onSessions={() => {
              if (window.matchMedia('(max-width: 899px)').matches) setListOpen(true);
              else document.querySelector<HTMLElement>('.chat-side .chat-session.is-current .chat-session-main, .chat-side .chat-session-main')?.focus();
            }}
            onRename={() => chat.current && setRenaming({ id: chat.current.id, title: chat.current.title })}
            onUsage={() => (usage ? setUsageOpen(true) : onNotify('No reply yet in this chat, so no usage to show'))}
            onAuto={toggleAuto}
            fill={fill}
          />
        </section>
      </div>

      <ConfirmDialog
        open={askAuto}
        icon="warning"
        title="Turn on auto mode?"
        message="OpenCode will run every shell command and file edit in this chat without asking, as bahar, who has sudo. It stays on for this chat until you turn it off."
        confirmLabel="Turn on"
        onCancel={() => setAskAuto(false)}
        onConfirm={() => {
          setAskAuto(false);
          void chat.setAuto(true);
        }}
      />

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
