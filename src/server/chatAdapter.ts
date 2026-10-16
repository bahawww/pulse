import type {
  ChatAgent,
  ChatCommand,
  ChatEvent,
  ChatFileHit,
  ChatHistory,
  ChatMention,
  ChatModelRef,
  ChatProviderList,
  ChatSession,
  ChatSubagent,
  ChatUpstream,
} from '../shared/contract.js';

/**
 * What src/server/chat.ts needs from an agent. OpenCode (chatOpencode.ts) is
 * the first; Claude Code, agy or Hermes plug in behind the same shape and
 * emit the same ChatEvent stream, so the browser needs no change.
 */
export interface ChatAdapter {
  readonly agent: ChatAgent;
  /** Where new sessions run. */
  readonly directory: string;
  /** Last known state of the agent server; null before anything is known. */
  status(): ChatUpstream | null;
  /** Asks the agent server now. */
  probe(): Promise<ChatUpstream>;
  /** Follow the agent's events; `sink` gets them already translated. */
  start(sink: (e: ChatEvent) => void): void;
  stop(): void;
  listSessions(): Promise<ChatSession[]>;
  createSession(title: string | null): Promise<ChatSession>;
  history(id: string): Promise<ChatHistory>;
  rename(id: string, title: string): Promise<ChatSession>;
  remove(id: string): Promise<void>;
  /** Starts a reply and returns at once; the reply arrives as events. @mentions become file or agent parts. */
  prompt(id: string, text: string, model: ChatModelRef | null, mentions: readonly ChatMention[]): Promise<void>;
  /** Slash commands the agent offers (the client adds its own: /new, /models ...). */
  commands(): Promise<ChatCommand[]>;
  subagents(): Promise<ChatSubagent[]>;
  /** Paths for @, in the session's directory (the default one with no session). */
  findFiles(id: string | null, query: string): Promise<ChatFileHit[]>;
  /** Runs a slash command; returns at once, the reply arrives as events. */
  command(id: string, name: string, args: string, model: ChatModelRef | null): Promise<void>;
  /** /compact: summarize the session so far. Returns at once. */
  compact(id: string, model: ChatModelRef | null): Promise<void>;
  /** /undo: revert the last prompt and its changes; answers that prompt's text, for the composer. */
  undo(id: string): Promise<{ text: string }>;
  /** /redo: bring back what /undo took. */
  redo(id: string): Promise<void>;
  share(id: string): Promise<{ url: string }>;
  /** Auto mode on or off; on also answers the requests already waiting. */
  setAuto(id: string, on: boolean): Promise<ChatSession>;
  unshare(id: string): Promise<void>;
  abort(id: string): Promise<void>;
  reply(id: string, requestID: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
  providers(): Promise<ChatProviderList>;
}

/** A failure with the HTTP status to answer the browser with. */
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
