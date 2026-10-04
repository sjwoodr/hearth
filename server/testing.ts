// Shared setup for the server tests: an in-memory database and a scripted stand-in for Ollama.
import { createApp } from './app.ts';
import { createModelScheduler } from './busy.ts';
import { openDb, type DB } from './db.ts';
import type { ChatFn, ChatMessage, ChatOptions } from './ollama.ts';
import { createUser } from './users.ts';
import type { SearchResult } from './web-search.ts';

export const ORIGIN = 'https://hearth.example.com';

export type FakeModel = {
  /** Every prompt the app sent, in order. */
  calls: ChatMessage[][];
  /** Chunks the next reply streams; a thrown Error mid-list simulates a failure. */
  reply: (string | Error)[];
  /** What memoryContext returns (the stable and recalled parts), and every lookup made. */
  memory: string;
  recalled: string;
  recallQueries: { userId: number; message: string }[];
  /** The next model-written title; an Error makes titling fail. */
  title: string | Error | undefined;
  /** Chats afterReply was called for. */
  afterReply: number[];
  /** While set, every reply waits for it before streaming: how a test holds a reply open. */
  gate?: Promise<unknown>;
  /** Prompts sent to the thinking variant; it reports THINKING_TOKENS of reasoning, then replies. */
  thinkingCalls: ChatMessage[][];
  /** Image describe requests, and what the next one answers; an Error makes it fail. */
  describeCalls: ChatMessage[][];
  description: string | Error;
  /** Queries the model asks to search for, one per reply (taken in order); none means it just answers. */
  asks: string[];
  /** Whether each reply was offered the web_search tool. */
  toolsOffered: boolean[];
  /** Queries the search engine actually ran, and what it returns; an Error makes it fail. */
  searched: string[];
  results: SearchResult[] | Error;
};

/** Pinned so the date in the search instructions is predictable. */
export const NOW = new Date('2026-10-02T12:00:00Z');

export const THINKING_TOKENS = 25;

/**
 * `db` reuses another app's database: a second app on it behaves like hearth after a restart (or
 * a second server process), with the database intact and server memory empty. `now` moves the clock.
 */
export function setupApp(
  opts: {
    numCtx?: number;
    systemPrompt?: string;
    thinkingReserve?: number;
    webSearch?: boolean;
    db?: DB;
    now?: () => Date;
    /** Ollama slots for the scheduler that wraps the fake model (default 1, as in production). */
    slots?: number;
  } = {},
) {
  const db = opts.db ?? openDb(':memory:');
  const model: FakeModel = {
    calls: [],
    reply: ['Hello', ' there.'],
    memory: '',
    recalled: '',
    recallQueries: [],
    title: undefined,
    afterReply: [],
    thinkingCalls: [],
    describeCalls: [],
    description: 'A page of French homework.',
    asks: [],
    toolsOffered: [],
    searched: [],
    results: [{ title: 'Fishbach tour', url: 'https://example.com/tour', snippet: 'Le Havre, 16 October.' }],
  };
  // A scripted search request stands in for the reply, as Ollama sends a tool call with no text.
  const askedToSearch = (o?: ChatOptions) => {
    model.toolsOffered.push(!!o?.tools?.length);
    const query = o?.tools?.length ? model.asks.shift() : undefined;
    if (query) o?.onToolCall?.({ function: { name: 'web_search', arguments: { query } } });
    return !!query;
  };
  // The real scheduler wraps the fake model, so route tests exercise real queueing and preemption.
  const scheduler = createModelScheduler({ slots: opts.slots ?? 1 });
  const chat: ChatFn = async function* (messages, signal, o) {
    model.calls.push(messages);
    await model.gate;
    if (askedToSearch(o)) return;
    for (const chunk of model.reply) {
      if (signal.aborted) throw new Error('aborted');
      if (chunk instanceof Error) throw chunk;
      yield chunk;
    }
  };
  const app = createApp({
    db,
    origin: ORIGIN,
    clientIp: (c) => c.req.header('x-test-ip') ?? '10.0.0.1',
    chat: scheduler.chat(chat),
    systemPrompt: () => opts.systemPrompt ?? 'You are hearth.',
    numCtx: opts.numCtx ?? 8192,
    thinkingReserve: opts.thinkingReserve,
    memoryContext: async (user, message) => {
      model.recallQueries.push({ userId: user.id, message });
      return { stable: model.memory, recalled: model.recalled };
    },
    thinkingChat: scheduler.chat(async function* (messages, _signal, o) {
      model.thinkingCalls.push(messages);
      for (let t = 1; t <= THINKING_TOKENS; t++) o?.onThinking?.(t);
      if (askedToSearch(o)) return;
      yield 'Considered answer.';
    }),
    titleFor: async () => {
      if (model.title instanceof Error) throw model.title;
      return model.title;
    },
    describeImages: async (messages) => {
      model.describeCalls.push(messages);
      if (model.description instanceof Error) throw model.description;
      return model.description;
    },
    afterReply: (id) => model.afterReply.push(id),
    ...(opts.webSearch
      ? {
          webSearch: async (query: string) => {
            model.searched.push(query);
            if (model.results instanceof Error) throw model.results;
            return model.results;
          },
          now: opts.now ?? (() => NOW),
        }
      : {}),
  });
  return { db, app, model, scheduler };
}

export type TestApp = ReturnType<typeof setupApp>['app'];

export async function login(app: TestApp, username: string, password: string, ip = '10.0.0.1') {
  return app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-test-ip': ip },
    body: JSON.stringify({ username, password }),
  });
}

export function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = /hearth_session=([^;]+)/.exec(header);
  if (!match) throw new Error(`no session cookie in: ${header}`);
  return `hearth_session=${match[1]}`;
}

/** Creates a user and signs them in; returns the session cookie. */
export async function signIn(ctx: ReturnType<typeof setupApp>, username: string): Promise<string> {
  await createUser(ctx.db, username, 'a good password');
  return sessionCookie(await login(ctx.app, username, 'a good password'));
}

/** An API request with the session cookie and a same-origin header, as JSON when there's a body. */
export function call(app: TestApp, cookie: string, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
