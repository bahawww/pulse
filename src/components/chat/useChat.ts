import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
  ChatEvent,
  ChatHistory,
  ChatMessage,
  ChatModelRef,
  ChatPart,
  ChatPermission,
  ChatProviderList,
  ChatSession,
  ChatUpstream,
} from '../../shared/contract';
import { sendJson } from '../../lib/csrf';

/**
 * State of the chat view: the session list, the open session's messages, and
 * one EventSource on /api/chat/events?session=<open id>. The stream is opened
 * again when the open session changes; every (re)open loads the list and the
 * history fresh, so nothing missed while it was down stays missing.
 */

const SESSION_KEY = 'vps_chat_session';
const MODEL_KEY = 'vps_chat_model';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function storedModel(): ChatModelRef | null {
  try {
    const m = JSON.parse(readStored(MODEL_KEY) ?? 'null') as ChatModelRef | null;
    return m && typeof m.providerID === 'string' && typeof m.modelID === 'string' ? m : null;
  } catch {
    return null;
  }
}

export class ChatRequestError extends Error {}

async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res =
    method === 'GET' ? await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } }) : await sendJson(method, path, body ?? {});
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ChatRequestError(data.error ?? `request failed (${res.status})`);
  return data as T;
}

// ---------------------------------------------------------------------------
// The open session
// ---------------------------------------------------------------------------

interface Thread {
  readonly sessionID: string;
  readonly messages: readonly ChatMessage[];
  readonly permissions: readonly ChatPermission[];
  readonly busy: boolean;
  readonly retry: string;
  readonly error: string;
}

type Delta = { readonly messageID: string; readonly partID: string; readonly delta: string };

type Action =
  | { readonly type: 'reset'; readonly thread: Thread | null }
  | { readonly type: 'event'; readonly event: ChatEvent }
  | { readonly type: 'deltas'; readonly list: readonly Delta[] }
  | { readonly type: 'dismiss-permission'; readonly id: string }
  | { readonly type: 'error'; readonly message: string };

function byTime(a: ChatMessage, b: ChatMessage): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function withMessage(messages: readonly ChatMessage[], id: string, role: 'user' | 'assistant', sessionID: string, fn: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === id);
  if (i >= 0) {
    const next = [...messages];
    next[i] = fn(messages[i]!);
    return next;
  }
  // A part before its message: a placeholder the message event fills in.
  const blank: ChatMessage = { id, sessionID, role, createdAt: Date.now(), completedAt: null, model: null, error: '', parts: [] };
  return [...messages, fn(blank)].sort(byTime);
}

function upsertPart(parts: readonly ChatPart[], part: ChatPart): ChatPart[] {
  const i = parts.findIndex((p) => p.id === part.id);
  if (i < 0) return [...parts, part];
  const next = [...parts];
  next[i] = part;
  return next;
}

function reduce(state: Thread | null, a: Action): Thread | null {
  if (a.type === 'reset') return a.thread;
  if (!state) return state;
  switch (a.type) {
    case 'error':
      return { ...state, error: a.message };
    case 'dismiss-permission':
      return { ...state, permissions: state.permissions.filter((p) => p.id !== a.id) };
    case 'deltas': {
      let messages = state.messages;
      for (const d of a.list) {
        messages = withMessage(messages, d.messageID, 'assistant', state.sessionID, (m) => {
          const part = m.parts.find((p) => p.id === d.partID);
          if (part && part.type !== 'tool' && part.type !== 'file') return { ...m, parts: upsertPart(m.parts, { ...part, text: part.text + d.delta }) };
          if (part) return m;
          return { ...m, parts: [...m.parts, { type: 'text', id: d.partID, text: d.delta }] };
        });
      }
      return { ...state, messages };
    }
    case 'event': {
      const e = a.event;
      switch (e.type) {
        case 'status':
          return e.sessionID === state.sessionID ? { ...state, busy: e.busy, retry: e.retry, error: e.busy ? '' : state.error } : state;
        case 'message':
          return {
            ...state,
            messages: withMessage(state.messages, e.message.id, e.message.role, state.sessionID, (m) => ({ ...m, ...e.message, parts: m.parts })).sort(byTime),
          };
        case 'message.removed':
          return { ...state, messages: state.messages.filter((m) => m.id !== e.messageID) };
        case 'part':
          return { ...state, messages: withMessage(state.messages, e.messageID, 'assistant', state.sessionID, (m) => ({ ...m, parts: upsertPart(m.parts, e.part) })) };
        case 'part.removed':
          return {
            ...state,
            messages: state.messages.map((m) => (m.id === e.messageID ? { ...m, parts: m.parts.filter((p) => p.id !== e.partID) } : m)),
          };
        case 'permission':
          return state.permissions.some((p) => p.id === e.permission.id) ? state : { ...state, permissions: [...state.permissions, e.permission] };
        case 'permission.replied':
          return { ...state, permissions: state.permissions.filter((p) => p.id !== e.id) };
        case 'error':
          return { ...state, error: e.message };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface Chat {
  readonly upstream: ChatUpstream | 'loading';
  readonly directory: string;
  readonly sessions: readonly ChatSession[] | null;
  readonly currentId: string | null;
  readonly current: ChatSession | null;
  readonly thread: Thread | null;
  readonly loadingThread: boolean;
  /** Text sent and not yet echoed back by the agent. */
  readonly pending: string;
  readonly providers: ChatProviderList | null;
  readonly model: ChatModelRef | null;
  readonly setModel: (m: ChatModelRef | null) => void;
  readonly open: (id: string | null) => void;
  readonly send: (text: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly answer: (p: ChatPermission, reply: 'once' | 'always' | 'reject') => Promise<void>;
  readonly rename: (id: string, title: string) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly retry: () => void;
}

export function useChat(notify: (text: string) => void): Chat {
  const [upstream, setUpstream] = useState<ChatUpstream | 'loading'>('loading');
  const [directory, setDirectory] = useState('');
  const [sessions, setSessions] = useState<readonly ChatSession[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(() => readStored(SESSION_KEY));
  const [thread, dispatch] = useReducer(reduce, null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [pending, setPending] = useState('');
  const [providers, setProviders] = useState<ChatProviderList | null>(null);
  const [model, setModelState] = useState<ChatModelRef | null>(storedModel);
  const [epoch, setEpoch] = useState(0);

  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  /** The latest upstream state, for handlers that must not wait for a render. */
  const upstreamRef = useRef<ChatUpstream | 'loading'>('loading');
  const applyUpstream = useCallback((next: ChatUpstream | 'loading') => {
    upstreamRef.current = next;
    setUpstream(next);
  }, []);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  /** Resolves when the stream for the open session is connected. */
  const streamReady = useRef<{ id: string | null; wait: Promise<void>; done: () => void } | null>(null);

  const open = useCallback((id: string | null) => {
    writeStored(SESSION_KEY, id);
    setCurrentId(id);
    setPending('');
  }, []);

  const setModel = useCallback((m: ChatModelRef | null) => {
    writeStored(MODEL_KEY, m ? JSON.stringify(m) : null);
    setModelState(m);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: list } = await api<{ sessions: ChatSession[] }>('GET', '/api/chat/sessions');
      setSessions(list);
    } catch {
      setSessions((s) => s ?? []);
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const h = await api<ChatHistory>('GET', `/api/chat/sessions/${id}`);
      if (currentRef.current !== id) return;
      dispatch({
        type: 'reset',
        thread: { sessionID: id, messages: [...h.messages].sort(byTime), permissions: h.permissions, busy: h.session.busy, retry: '', error: '' },
      });
      setSessions((list) => (list && !list.some((s) => s.id === id) ? [h.session, ...list] : list));
    } catch (err) {
      if (currentRef.current !== id) return;
      if (err instanceof ChatRequestError && /not found|404/i.test(err.message)) open(null);
      else dispatch({ type: 'reset', thread: { sessionID: id, messages: [], permissions: [], busy: false, retry: '', error: err instanceof Error ? err.message : 'could not load' } });
    } finally {
      if (currentRef.current === id) setLoadingThread(false);
    }
  }, [open]);

  const loadProviders = useCallback(() => {
    void api<ChatProviderList>('GET', '/api/chat/providers')
      .then(setProviders)
      .catch(() => undefined);
  }, []);

  /** Everything the agent holds. Only while it is up: down, each call would only fail. */
  const loadAll = useCallback(() => {
    void loadSessions();
    if (currentRef.current) void loadThread(currentRef.current);
  }, [loadSessions, loadThread]);

  // Status first (and on retry); the rest once the agent answers.
  useEffect(() => {
    let alive = true;
    void api<{ status: ChatUpstream; directory: string }>('GET', '/api/chat/status')
      .then((s) => {
        if (!alive) return;
        applyUpstream(s.status);
        setDirectory(s.directory);
        if (s.status === 'up') {
          loadAll();
          loadProviders();
        }
      })
      .catch(() => alive && applyUpstream('down'));
    return () => {
      alive = false;
    };
  }, [epoch, applyUpstream, loadAll, loadProviders]);

  // The thread follows the open session.
  useEffect(() => {
    if (!currentId) {
      dispatch({ type: 'reset', thread: null });
      return;
    }
    dispatch({ type: 'reset', thread: { sessionID: currentId, messages: [], permissions: [], busy: false, retry: '', error: '' } });
  }, [currentId]);

  // The event stream, one per open session.
  useEffect(() => {
    let done = () => undefined as void;
    const wait = new Promise<void>((r) => {
      done = r;
    });
    streamReady.current = { id: currentId, wait, done };
    const es = new EventSource(`/api/chat/events${currentId ? `?session=${encodeURIComponent(currentId)}` : ''}`);
    let deltas: Delta[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const list = deltas;
      deltas = [];
      if (list.length) dispatch({ type: 'deltas', list });
    };
    es.onopen = () => {
      streamReady.current?.done();
      // A reconnect may have missed events: load fresh. On the first open the status call does it.
      if (upstreamRef.current === 'up') loadAll();
    };
    es.addEventListener('chat', (msg) => {
      let e: ChatEvent;
      try {
        e = JSON.parse((msg as MessageEvent<string>).data) as ChatEvent;
      } catch {
        return;
      }
      switch (e.type) {
        case 'upstream': {
          const was = upstreamRef.current;
          applyUpstream(e.status);
          // Back up after an outage: what happened meanwhile is only in a fresh load.
          if (e.status === 'up' && was !== 'up' && was !== 'loading') {
            loadAll();
            loadProviders();
          }
          return;
        }
        case 'session':
          setSessions((list) => {
            const rest = (list ?? []).filter((s) => s.id !== e.session.id);
            return [e.session, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
          });
          return;
        case 'session.deleted':
          setSessions((list) => (list ?? []).filter((s) => s.id !== e.sessionID));
          if (currentRef.current === e.sessionID) open(null);
          return;
        case 'status':
          setSessions((list) => list?.map((s) => (s.id === e.sessionID ? { ...s, busy: e.busy } : s)) ?? list);
          dispatch({ type: 'event', event: e });
          return;
        case 'delta':
          deltas.push(e);
          frame ||= requestAnimationFrame(flush);
          return;
        case 'message':
          if (e.message.role === 'user') setPending('');
          flush();
          dispatch({ type: 'event', event: e });
          return;
        default:
          flush();
          dispatch({ type: 'event', event: e });
      }
    });
    es.addEventListener('bye', () => es.close());
    return () => {
      cancelAnimationFrame(frame);
      es.close();
    };
  }, [currentId, epoch, loadAll, loadProviders, applyUpstream, open]);

  const send = useCallback(
    async (text: string) => {
      let id = currentRef.current;
      setPending(text);
      try {
        if (!id) {
          const { session } = await api<{ session: ChatSession }>('POST', '/api/chat/sessions', {});
          id = session.id;
          setSessions((list) => [session, ...(list ?? []).filter((s) => s.id !== session.id)]);
          writeStored(SESSION_KEY, id);
          currentRef.current = id;
          setCurrentId(id);
          // Let the new session's stream connect first, or the start of the reply is missed.
          const started = Date.now();
          while (streamReady.current?.id !== id && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 30));
          await Promise.race([streamReady.current?.wait, new Promise((r) => setTimeout(r, 3000))]);
        }
        await api('POST', `/api/chat/sessions/${id}/prompt`, { text, ...(model ? { model } : {}) });
      } catch (err) {
        setPending('');
        const message = err instanceof Error ? err.message : 'could not send';
        dispatch({ type: 'error', message });
        notifyRef.current(message);
        throw err;
      }
    },
    [model],
  );

  const abort = useCallback(async () => {
    const id = currentRef.current;
    if (!id) return;
    await api('POST', `/api/chat/sessions/${id}/abort`).catch((err: unknown) => notifyRef.current(err instanceof Error ? err.message : 'could not stop'));
  }, []);

  const answer = useCallback(async (p: ChatPermission, reply: 'once' | 'always' | 'reject') => {
    try {
      await api('POST', `/api/chat/sessions/${p.sessionID}/permissions/${p.id}`, { reply });
      dispatch({ type: 'dismiss-permission', id: p.id });
    } catch (err) {
      notifyRef.current(err instanceof Error ? err.message : 'could not answer');
      if (err instanceof ChatRequestError && /already answered/.test(err.message)) dispatch({ type: 'dismiss-permission', id: p.id });
    }
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    try {
      const { session } = await api<{ session: ChatSession }>('PATCH', `/api/chat/sessions/${id}`, { title });
      setSessions((list) => list?.map((s) => (s.id === id ? session : s)) ?? list);
    } catch (err) {
      notifyRef.current(err instanceof Error ? err.message : 'could not rename');
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api('DELETE', `/api/chat/sessions/${id}`);
        setSessions((list) => list?.filter((s) => s.id !== id) ?? list);
        if (currentRef.current === id) open(null);
      } catch (err) {
        notifyRef.current(err instanceof Error ? err.message : 'could not delete');
      }
    },
    [open],
  );

  const retry = useCallback(() => {
    applyUpstream('loading');
    setEpoch((n) => n + 1);
  }, [applyUpstream]);

  const current = sessions?.find((s) => s.id === currentId) ?? null;
  return {
    upstream,
    directory,
    sessions,
    currentId,
    current,
    thread: thread && thread.sessionID === currentId ? thread : null,
    loadingThread,
    pending,
    providers,
    model,
    setModel,
    open,
    send,
    abort,
    answer,
    rename,
    remove,
    retry,
  };
}
