import type { ChatAgent, ChatEvent, ChatHistory, ChatModelRef, ChatProviderList, ChatSession, ChatUpstream } from '../shared/contract.js';

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
  /** Starts a reply and returns at once; the reply arrives as events. */
  prompt(id: string, text: string, model: ChatModelRef | null): Promise<void>;
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
