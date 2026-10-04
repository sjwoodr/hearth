// hearth's real Ollama client talking over HTTP to a real gateway, with a fake Ollama behind it:
// the path a multi-process deployment takes (HEARTH_GATEWAY_URL).
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelScheduler, PreemptedError } from './busy.ts';
import { createGateway } from './gateway.ts';
import { ollamaChat, ollamaEmbed, ollamaJson, ollamaThinkingChat, type Endpoint } from './ollama.ts';

const TOKEN = 'client-test-token';
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ready()).toBe(true);
}

/** A fake Ollama: records what reached it, can hold a call open, and notices aborts. */
function fakeOllama() {
  const seen: { priority?: string; user?: string; auth?: string; think?: boolean; stream?: boolean }[] = [];
  const aborted: string[] = [];
  const state = { hold: undefined as Promise<void> | undefined };
  const app = new Hono();
  const held = (signal: AbortSignal, label: string) =>
    new Promise<void>((resolve, reject) => {
      if (!state.hold) return resolve();
      signal.addEventListener('abort', () => (aborted.push(label), reject(new Error('aborted'))));
      state.hold.then(resolve);
    });
  app.post('/api/chat', async (c) => {
    const body = await c.req.json();
    const label = body.messages?.at(-1)?.content ?? '?';
    seen.push({
      priority: c.req.header('x-hearth-priority'),
      user: c.req.header('x-hearth-user'),
      auth: c.req.header('authorization'),
      think: body.think,
      stream: body.stream,
    });
    if (body.stream === false) {
      await held(c.req.raw.signal, label);
      return c.json({ message: { content: 'plain text answer' }, done: true });
    }
    return stream(c, async (s) => {
      const write = (o: object) => s.write(`${JSON.stringify(o)}\n`);
      if (body.think) await write({ message: { thinking: 'Hmm.' } });
      await write({ message: { content: 'Bon' } });
      try {
        await held(c.req.raw.signal, label);
      } catch {
        return;
      }
      await write({ message: { content: 'jour' } });
      await write({ done: true });
    });
  });
  app.post('/api/embed', async (c) => {
    seen.push({ auth: c.req.header('authorization') });
    return c.json({ embeddings: [[0.5, 0.5]] });
  });
  return { app, seen, aborted, state };
}

async function setup(slots = 1) {
  const ollama = fakeOllama();
  const scheduler = createModelScheduler({ slots });
  const gateway = createGateway({
    upstream: 'http://ollama.test',
    token: TOKEN,
    scheduler,
    fetch: ((url: string, init?: RequestInit) => ollama.app.request(url, init)) as typeof fetch,
  });
  // What hearth's client sent to the gateway, before the gateway strips it for Ollama.
  const arrived: { priority: string | null; user: string | null; token: boolean }[] = [];
  const recordThenServe = (req: Request) => {
    arrived.push({
      priority: req.headers.get('x-hearth-priority'),
      user: req.headers.get('x-hearth-user'),
      token: req.headers.get('authorization') === `Bearer ${TOKEN}`,
    });
    return gateway.fetch(req);
  };
  const server = serve({ fetch: recordThenServe, hostname: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint: Endpoint = { url, token: TOKEN };
  return { ollama, scheduler, endpoint, url, arrived };
}

async function collect(chunks: AsyncIterable<string>) {
  let text = '';
  for await (const c of chunks) text += c;
  return text;
}

describe('hearth through the gateway', () => {
  it('streams a reply, sending the token, its priority and the user', async () => {
    const { ollama, endpoint, arrived } = await setup();
    const chat = ollamaChat(endpoint, 'm', 1024);
    expect(await collect(chat([{ role: 'user', content: 'Salut' }], new AbortController().signal, { userId: 7 }))).toBe('Bonjour');
    expect(arrived).toEqual([{ priority: 'reply', user: '7', token: true }]);
    // The gateway keeps all of that to itself: Ollama gets the request and nothing else.
    expect(ollama.seen).toEqual([{ priority: undefined, user: undefined, auth: undefined, think: false, stream: true }]);
  });

  it('turns the gateway\'s queue lines into onQueued, and keeps them out of the reply', async () => {
    const { ollama, endpoint } = await setup(1);
    const chat = ollamaChat(endpoint, 'm', 1024);
    const held = gate();
    ollama.state.hold = held.promise;
    const first = collect(chat([{ role: 'user', content: 'first' }], new AbortController().signal, { userId: 1 }));
    await until(() => ollama.seen.length === 1);
    const positions: number[] = [];
    const second = collect(chat([{ role: 'user', content: 'second' }], new AbortController().signal, { userId: 2, onQueued: (n) => positions.push(n) }));
    await until(() => positions.length === 1);
    expect(positions).toEqual([1]);
    held.open();
    expect(await Promise.all([first, second])).toEqual(['Bonjour', 'Bonjour']);
  });

  it('reports a background call the gateway preempted as PreemptedError', async () => {
    const { ollama, endpoint, arrived } = await setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const job = ollamaJson(endpoint, 'm', 1024)([{ role: 'user', content: 'extract' }], null);
    await until(() => ollama.seen.length === 1);
    expect(arrived[0]).toEqual({ priority: 'background', user: null, token: true });
    const reply = collect(ollamaChat(endpoint, 'm', 1024)([{ role: 'user', content: 'hi' }], new AbortController().signal, { userId: 1 }));
    await expect(job).rejects.toBeInstanceOf(PreemptedError);
    expect(ollama.aborted).toEqual(['extract']);
    held.open();
    expect(await reply).toBe('Bonjour');
  });

  it('passes queue lines through the thinking path too, and its fallback carries the user', async () => {
    const { ollama, endpoint, arrived } = await setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const busy = collect(ollamaChat(endpoint, 'm', 1024)([{ role: 'user', content: 'busy' }], new AbortController().signal, { userId: 1 }));
    await until(() => ollama.seen.length === 1);
    const positions: number[] = [];
    // A budget of 1 cuts the reasoning at once, so the "answer now" fallback runs as a second request.
    const thinking = ollamaThinkingChat(endpoint, 'm', 1024, 1);
    const answer = collect(thinking([{ role: 'user', content: 'pourquoi ?' }], new AbortController().signal, { userId: 2, onQueued: (n) => positions.push(n) }));
    await until(() => positions.length === 1);
    held.open();
    await busy;
    expect(await answer).toBe('Bonjour');
    expect(ollama.seen.slice(1).map((r) => r.think)).toEqual([true, false]);
    expect(arrived.slice(1)).toEqual([
      { priority: 'reply', user: '2', token: true },
      { priority: 'reply', user: '2', token: true },
    ]);
  });

  it('sends embeddings through the gateway with the token, not queued behind replies', async () => {
    const { ollama, endpoint } = await setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const busy = collect(ollamaChat(endpoint, 'm', 1024)([{ role: 'user', content: 'busy' }], new AbortController().signal));
    await until(() => ollama.seen.length === 1);
    expect(await ollamaEmbed(endpoint, 'e')(['abeilles'])).toEqual([[0.5, 0.5]]);
    held.open();
    await busy;
  });

  it('fails clearly with a wrong token', async () => {
    const { url } = await setup();
    const chat = ollamaChat({ url, token: 'wrong' }, 'm', 1024);
    await expect(collect(chat([{ role: 'user', content: 'x' }], new AbortController().signal))).rejects.toThrow(/401/);
    await expect(ollamaJson(url, 'm', 1024)([{ role: 'user', content: 'x' }], null)).rejects.toThrow(/401/);
  });
});
