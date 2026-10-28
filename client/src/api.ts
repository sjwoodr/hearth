import type { Effort } from '../../shared/think-effort.ts';

export class ApiError extends Error {
  status: number;
  retryAfterSeconds?: number;
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The model every answer says is in use (X-Hearth-Model): an admin can switch it for everyone. */
export type ModelHeader = { model: string; isDefault: boolean };
const modelListeners = new Set<(m: ModelHeader) => void>();
/** Calls `listener` with the model each response reports; returns the unsubscribe. */
export function onModelHeader(listener: (m: ModelHeader) => void): () => void {
  modelListeners.add(listener);
  return () => modelListeners.delete(listener);
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  // Non-GET requests are always JSON. With no Content-Type, Hono's csrf() treats the request
  // as a form post and checks Origin, which fails for any LAN name other than HEARTH_ORIGIN.
  const isRead = method === 'GET';
  const res = await fetch(path, {
    method,
    headers: isRead ? undefined : { 'Content-Type': 'application/json' },
    body: isRead ? undefined : JSON.stringify(body ?? {}),
    signal,
  });
  const model = res.headers.get('X-Hearth-Model');
  if (model) for (const listener of modelListeners) listener({ model, isDefault: res.headers.get('X-Hearth-Model-Default') === '1' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.retryAfterSeconds);
  }
  return res;
}

const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> =>
  (await send(method, path, body)).json() as Promise<T>;

/** `name` is the display name, or the username when none is set. An admin can switch the model. */
export type Me = { username: string; name: string; role?: 'user' | 'admin'; isAdmin?: boolean };
/** A chat model Ollama has; `capabilities` from Ollama (vision, thinking, tools). */
/** `aliases`: other tags of the same weights, shown once. */
export type ModelInfo = { name: string; size: number; parameterSize?: string; quantization?: string; capabilities: string[]; aliases?: string[] };
export type ActiveModel = { model: string; default: string; isDefault: boolean; since?: string; by?: string; lastUsed?: string };
export type Conversation = { id: number; title: string | null; created_at: string; updated_at: string };
export type Source = { title: string; url: string };
/** A chat's unsummarized history (estimated tokens) against where it gets folded into the summary. */
export type ContextUse = { used: number; foldAt: number };
/** A pass that folded older messages into the chat's summary; the chat shows a line after `afterMessageId`. */
export type SummaryFold = { afterMessageId: number; folded: number };
/**
 * `image_count` images came with the message; `image_note` is hearth's description of them, once
 * written. `sources`: the pages a reply drew on, when it followed a web search.
 */
export type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  image_count: number;
  image_note: string | null;
  sources: Source[] | null;
  created_at: string;
};

/** A private chat's message as sent back with each new one. */
export type PrivateMessage = { role: 'user' | 'assistant'; content: string; imageCount?: number; sources?: Source[] | null };

export type SearchHit = {
  conversationId: number;
  title: string | null;
  messageId: number;
  role: 'user' | 'assistant';
  /** Matches are wrapped in \u0002 … \u0003. */
  snippet: string;
  created_at: string;
};

export type MemoryKind = 'profile' | 'fact';
export type Memory = {
  id: number;
  kind: MemoryKind;
  content: string;
  source_conversation_id: number | null;
  created_at: string;
  updated_at: string;
};

export type StreamEvent =
  /** `effort` and `budget`: how hard a thinking reply may think, and its cap in reasoning tokens. */
  | { type: 'start'; userMessageId?: number; model?: string; think?: boolean; effort?: Effort; budget?: number; reason?: string }
  | { type: 'queued' }
  /** Ollama had unloaded the model; this reply waits while it loads (~15 s). */
  | { type: 'loading' }
  | { type: 'thinking'; tokens: number }
  | { type: 'title'; title: string }
  | { type: 'delta'; text: string }
  | { type: 'searching'; query: string }
  /** The model asked to search for `query`; the reply waits for answerSearch. */
  | { type: 'search'; query: string }
  /** No `messageId` in a private chat: nothing was saved. */
  | { type: 'done'; messageId?: number; selfCorrected?: boolean; sources?: Source[]; context?: ContextUse; folds?: SummaryFold[] }
  | { type: 'stopped'; messageId?: number }
  | { type: 'error'; error: string };

/** Yields a reply's stream events as they arrive. */
async function* readEvents(res: Response): AsyncGenerator<StreamEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line) as StreamEvent;
    }
  }
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  login: (username: string, password: string) => request<Me>('POST', '/api/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  createConversation: () => request<Conversation>('POST', '/api/conversations'),
  conversation: (id: number) =>
    request<{ conversation: Conversation; messages: Message[]; pendingSearch: { query: string } | null; replying: boolean; context: ContextUse; folds: SummaryFold[] }>(
      'GET',
      `/api/conversations/${id}`,
    ),
  renameConversation: (id: number, title: string) => request('PATCH', `/api/conversations/${id}`, { title }),
  deleteConversation: (id: number) => request('DELETE', `/api/conversations/${id}`),
  /**
   * `images`: data URLs, sent once and never stored. `think`: true always thinks, false never,
   * "auto" lets the server decide per message. `effort`: how hard to think when it does.
   */
  sendMessage: async function* (
    conversationId: number,
    content: string,
    images: string[],
    think: boolean | 'auto',
    effort: Effort,
    signal: AbortSignal,
  ) {
    yield* readEvents(await send('POST', `/api/conversations/${conversationId}/messages`, { content, images, think, effort }, signal));
  },
  retry: async function* (conversationId: number, think: boolean | 'auto', effort: Effort, signal: AbortSignal) {
    yield* readEvents(await send('POST', `/api/conversations/${conversationId}/retry`, { think, effort }, signal));
  },
  /** Stops the reply being written in that chat. Closing the connection doesn't: the reply carries on. */
  stop: (conversationId: number) => request<{ stopped: boolean }>('POST', `/api/conversations/${conversationId}/stop`),
  /** The user's answer to a search card: only `approve: true` runs the search. */
  answerSearch: async function* (conversationId: number, approve: boolean, signal: AbortSignal) {
    yield* readEvents(await send('POST', `/api/conversations/${conversationId}/search`, { approve }, signal));
  },
  /**
   * A private chat: the whole chat goes with each message, since the server keeps none of it.
   * `images` belong to the last message (sent again for a retry); earlier ones are gone.
   */
  privateMessage: async function* (
    chatId: string,
    messages: PrivateMessage[],
    images: string[],
    think: boolean | 'auto',
    effort: Effort,
    signal: AbortSignal,
  ) {
    yield* readEvents(await send('POST', `/api/private/${chatId}/messages`, { messages, images, think, effort }, signal));
  },
  privateSearch: async function* (chatId: string, approve: boolean, signal: AbortSignal) {
    yield* readEvents(await send('POST', `/api/private/${chatId}/search`, { approve }, signal));
  },
  privateStop: (chatId: string) => request<{ stopped: boolean }>('POST', `/api/private/${chatId}/stop`),
  /** Ends a private chat on the server: stops its reply and drops a waiting search. */
  endPrivate: (chatId: string) => request('DELETE', `/api/private/${chatId}`),
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  memories: () => request<Memory[]>('GET', '/api/memories'),
  addMemory: (kind: MemoryKind, content: string) => request<Memory>('POST', '/api/memories', { kind, content }),
  updateMemory: (id: number, change: { kind?: MemoryKind; content?: string }) =>
    request<Memory>('PATCH', `/api/memories/${id}`, change),
  deleteMemory: (id: number) => request('DELETE', `/api/memories/${id}`),
  /** Admin only: the chat models Ollama has, and the one in use. */
  models: () => request<{ active: ActiveModel; models: ModelInfo[] }>('GET', '/api/models'),
  setModel: (model: string) => request<{ active: ActiveModel }>('PUT', '/api/model', { model }),
  resetModel: () => request<{ active: ActiveModel }>('DELETE', '/api/model'),
};
