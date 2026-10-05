import { describe, expect, it } from 'vitest';
import { estimateTokens, fitHistory } from './context.ts';
import { titleFrom } from './conversations.ts';
import type { ChatMessage } from './ollama.ts';
import { login, ORIGIN, sessionCookie, setupApp, type TestApp } from './testing.ts';
import { createUser } from './users.ts';

async function signIn(ctx: ReturnType<typeof setupApp>, username: string) {
  await createUser(ctx.db, username, 'a good password');
  return sessionCookie(await login(ctx.app, username, 'a good password'));
}

function call(app: TestApp, cookie: string, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newChat(app: TestApp, cookie: string): Promise<number> {
  return ((await (await call(app, cookie, 'POST', '/conversations')).json()) as { id: number }).id;
}

async function say(app: TestApp, cookie: string, id: number, content: string) {
  const res = await call(app, cookie, 'POST', `/conversations/${id}/messages`, { content });
  const events = res.ok
    ? (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; text?: string; error?: string })
    : [];
  return { res, events };
}

const stored = async (app: TestApp, cookie: string, id: number) =>
  (await (await call(app, cookie, 'GET', `/conversations/${id}`)).json()) as {
    conversation: { title: string | null };
    messages: { role: string; content: string }[];
  };

describe('chatting', () => {
  it('streams the reply, then saves both messages and titles the chat', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);

    const { res, events } = await say(ctx.app, cookie, id, 'Tell me about   contesting.');
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Hello there.');

    const chat = await stored(ctx.app, cookie, id);
    expect(chat.conversation.title).toBe('Tell me about contesting.');
    expect(chat.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Tell me about   contesting.' }),
      expect.objectContaining({ role: 'assistant', content: 'Hello there.' }),
    ]);
    expect(ctx.model.calls[0]).toEqual([
      { role: 'system', content: 'You are hearth.' },
      { role: 'user', content: 'Tell me about   contesting.' },
    ]);
  });

  it('sends earlier turns as history and keeps the first title', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, 'First');
    ctx.model.reply = ['Second answer'];
    await say(ctx.app, cookie, id, 'Second');
    expect(ctx.model.calls[1]!.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:You are hearth.',
      'user:First',
      'assistant:Hello there.',
      'user:Second',
    ]);
    expect((await stored(ctx.app, cookie, id)).conversation.title).toBe('First');
  });

  it('keeps the partial reply and reports an error when the model fails mid-stream', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.reply = ['Half a', new Error('Ollama: model crashed')];
    const { events } = await say(ctx.app, cookie, id, 'Hi');
    expect(events.at(-1)).toEqual({ type: 'error', error: 'Ollama: model crashed' });
    expect((await stored(ctx.app, cookie, id)).messages.map((m) => m.content)).toEqual(['Hi', 'Half a']);
  });

  it('treats an empty reply as an error and saves no assistant message', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    ctx.model.reply = ['  '];
    const { events } = await say(ctx.app, cookie, id, 'Hi');
    expect(events.at(-1)?.type).toBe('error');
    expect((await stored(ctx.app, cookie, id)).messages).toHaveLength(1);
  });

  it('rejects empty and oversized messages without saving them or calling the model', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    expect((await say(ctx.app, cookie, id, '   ')).res.status).toBe(400);
    expect((await say(ctx.app, cookie, id, 'x'.repeat(16_001))).res.status).toBe(400);
    expect((await stored(ctx.app, cookie, id)).messages).toHaveLength(0);
    expect(ctx.model.calls).toHaveLength(0);
  });

  it('renames and deletes chats', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await say(ctx.app, cookie, id, 'Hi');
    expect((await call(ctx.app, cookie, 'PATCH', `/conversations/${id}`, { title: '' })).status).toBe(400);
    expect((await call(ctx.app, cookie, 'PATCH', `/conversations/${id}`, { title: 'Radio' })).status).toBe(200);
    expect((await stored(ctx.app, cookie, id)).conversation.title).toBe('Radio');
    expect((await call(ctx.app, cookie, 'DELETE', `/conversations/${id}`)).status).toBe(200);
    expect((await call(ctx.app, cookie, 'GET', `/conversations/${id}`)).status).toBe(404);
    expect((ctx.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
  });
});

describe('isolation between users', () => {
  it("never lets one user see, change or post to another user's chat", async () => {
    const ctx = setupApp();
    const alice = await signIn(ctx, 'alice');
    const bob = await signIn(ctx, 'bob');
    const id = await newChat(ctx.app, alice);
    await say(ctx.app, alice, id, 'private thoughts');

    expect(await (await call(ctx.app, bob, 'GET', '/conversations')).json()).toEqual([]);
    expect((await call(ctx.app, bob, 'GET', `/conversations/${id}`)).status).toBe(404);
    expect((await call(ctx.app, bob, 'PATCH', `/conversations/${id}`, { title: 'mine now' })).status).toBe(404);
    expect((await call(ctx.app, bob, 'DELETE', `/conversations/${id}`)).status).toBe(404);
    expect((await say(ctx.app, bob, id, 'hijack')).res.status).toBe(404);

    const chat = await stored(ctx.app, alice, id);
    expect(chat.conversation.title).toBe('private thoughts');
    expect(chat.messages).toHaveLength(2);
    expect(ctx.model.calls).toHaveLength(1);
  });

  it('requires a session for every chat route', async () => {
    const { app } = setupApp();
    for (const [method, path] of [
      ['GET', '/conversations'],
      ['POST', '/conversations'],
      ['GET', '/conversations/1'],
      ['POST', '/conversations/1/messages'],
    ] as const) {
      expect((await call(app, '', method, path)).status).toBe(401);
    }
  });
});

describe('fitting history into the context window', () => {
  const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

  it('keeps the system prompt and drops the oldest turns first', () => {
    const history = [msg('user', 'a'.repeat(350)), msg('assistant', 'b'.repeat(350)), msg('user', 'c'.repeat(350))];
    const budget = estimateTokens('sys') + 2 * estimateTokens('c'.repeat(350));
    const fitted = fitHistory('sys', history, budget);
    expect(fitted.map((m) => m.content[0])).toEqual(['s', 'b', 'c']);
  });

  it('always keeps the latest message, even if it alone is over budget', () => {
    const fitted = fitHistory('sys', [msg('user', 'old'), msg('user', 'x'.repeat(10_000))], 10);
    expect(fitted).toHaveLength(2);
    expect(fitted[1]!.content).toHaveLength(10_000);
  });
});

describe('titles', () => {
  it('collapses whitespace and shortens long first messages', () => {
    expect(titleFrom('  hello\n\nthere ')).toBe('hello there');
    const long = titleFrom('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the "loading the model" notice', () => {
  // The fake model's first word waits briefly, as a real model's does, so the check (answered at
  // once) lands first, deterministically.
  const slowStart = (ctx: ReturnType<typeof setupApp>) => (ctx.model.gate = new Promise((r) => setTimeout(r, 30)));
  const types = (events: { type: string }[]) => events.map((e) => e.type);

  it('says the model is loading, before the first word, when Ollama has unloaded it', async () => {
    const ctx = setupApp({ modelLoaded: { answer: false } });
    const cookie = await signIn(ctx, 'alice');
    slowStart(ctx);
    const { events } = await say(ctx.app, cookie, await newChat(ctx.app, cookie), 'Bonjour');
    expect(types(events).slice(0, 3)).toEqual(['start', 'loading', 'delta']);
    expect(types(events).at(-1)).toBe('done');
  });

  it('says nothing when the model is loaded, or when it can\'t tell', async () => {
    for (const answer of [true, undefined]) {
      const ctx = setupApp({ modelLoaded: { answer } });
      const cookie = await signIn(ctx, 'alice');
      slowStart(ctx);
      const { events } = await say(ctx.app, cookie, await newChat(ctx.app, cookie), 'Bonjour');
      expect(types(events)).not.toContain('loading');
      expect(ctx.model.loadedChecks).toEqual([false]);
    }
  });

  it('never says it once words are arriving (a slow check landing mid-reply)', async () => {
    // Words every 40 ms; the check answers at 50 ms, after the first word and before the last.
    const ctx = setupApp({ modelLoaded: { answer: false, delayMs: 50 } });
    const cookie = await signIn(ctx, 'alice');
    ctx.model.reply = ['Bon', 'jour', ' !', ' Ça', ' va ?'];
    ctx.model.chunkDelayMs = 40;
    const { events } = await say(ctx.app, cookie, await newChat(ctx.app, cookie), 'Bonjour');
    expect(types(events).filter((t) => t === 'delta')).toHaveLength(5);
    expect(types(events)).not.toContain('loading');
  });

  it('asks about the thinking model when the reply thinks', async () => {
    const ctx = setupApp({ modelLoaded: { answer: true } });
    const cookie = await signIn(ctx, 'alice');
    const id = await newChat(ctx.app, cookie);
    await (await call(ctx.app, cookie, 'POST', `/conversations/${id}/messages`, { content: 'Bonjour', think: true })).text();
    expect(ctx.model.loadedChecks).toEqual([true]);
  });
});
