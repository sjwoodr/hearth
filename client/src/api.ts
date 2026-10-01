export class ApiError extends Error {
  status: number;
  retryAfterSeconds?: number;
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.retryAfterSeconds);
  }
  return res;
}

const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> =>
  (await send(method, path, body)).json() as Promise<T>;

/** `name` is the display name, or the username when none is set. */
export type Me = { username: string; name: string };
export type Conversation = { id: number; title: string | null; created_at: string; updated_at: string };
export type Message = { id: number; role: 'user' | 'assistant'; content: string; created_at: string };

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
  | { type: 'start'; userMessageId: number; think?: boolean; reason?: string }
  | { type: 'queued' }
  | { type: 'thinking'; tokens: number }
  | { type: 'title'; title: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: number; selfCorrected?: boolean }
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
    request<{ conversation: Conversation; messages: Message[] }>('GET', `/api/conversations/${id}`),
  renameConversation: (id: number, title: string) => request('PATCH', `/api/conversations/${id}`, { title }),
  deleteConversation: (id: number) => request('DELETE', `/api/conversations/${id}`),
  /** `think`: true always thinks, false never, "auto" lets the server decide per message. */
  sendMessage: async function* (conversationId: number, content: string, think: boolean | 'auto', signal: AbortSignal) {
    yield* readEvents(await send('POST', `/api/conversations/${conversationId}/messages`, { content, think }, signal));
  },
  retry: async function* (conversationId: number, think: boolean | 'auto', signal: AbortSignal) {
    yield* readEvents(await send('POST', `/api/conversations/${conversationId}/retry`, { think }, signal));
  },
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  memories: () => request<Memory[]>('GET', '/api/memories'),
  addMemory: (kind: MemoryKind, content: string) => request<Memory>('POST', '/api/memories', { kind, content }),
  updateMemory: (id: number, change: { kind?: MemoryKind; content?: string }) =>
    request<Memory>('PATCH', `/api/memories/${id}`, change),
  deleteMemory: (id: number) => request('DELETE', `/api/memories/${id}`),
};
