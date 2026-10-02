// Shared setup for the server tests: an in-memory database and a scripted stand-in for Ollama.
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import type { ChatFn, ChatMessage } from './ollama.ts';
import { createUser } from './users.ts';

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
  /** Whether another reply is "active", and how many times background work was preempted. */
  busy: boolean;
  preempted: number;
  /** Prompts sent to the thinking variant; it reports THINKING_TOKENS of reasoning, then replies. */
  thinkingCalls: ChatMessage[][];
  /** Image describe requests, and what the next one answers; an Error makes it fail. */
  describeCalls: ChatMessage[][];
  description: string | Error;
};

export const THINKING_TOKENS = 25;

export function setupApp(opts: { numCtx?: number; systemPrompt?: string; thinkingReserve?: number } = {}) {
  const db = openDb(':memory:');
  const model: FakeModel = {
    calls: [],
    reply: ['Hello', ' there.'],
    memory: '',
    recalled: '',
    recallQueries: [],
    title: undefined,
    afterReply: [],
    busy: false,
    preempted: 0,
    thinkingCalls: [],
    describeCalls: [],
    description: 'A page of French homework.',
  };
  const chat: ChatFn = async function* (messages, signal) {
    model.calls.push(messages);
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
    chat,
    systemPrompt: () => opts.systemPrompt ?? 'You are hearth.',
    numCtx: opts.numCtx ?? 8192,
    thinkingReserve: opts.thinkingReserve,
    memoryContext: async (user, message) => {
      model.recallQueries.push({ userId: user.id, message });
      return { stable: model.memory, recalled: model.recalled };
    },
    thinkingChat: async function* (messages, _signal, opts) {
      model.thinkingCalls.push(messages);
      for (let t = 1; t <= THINKING_TOKENS; t++) opts?.onThinking?.(t);
      yield 'Considered answer.';
    },
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
    replyActive: () => model.busy,
    preemptBackground: () => {
      model.preempted++;
    },
  });
  return { db, app, model };
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
