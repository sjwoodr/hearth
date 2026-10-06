import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { describe, expect, it } from 'vitest';
import { createModelScheduler } from './busy.ts';
import { createGateway } from './gateway.ts';

const TOKEN = 'test-token';

/** A promise a test opens by hand, to hold a model call. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ready()).toBe(true);
}

/** Stands in for Ollama: records requests, can hold them open, and notices aborts. */
function fakeOllama() {
  const seen: { path: string; body: { stream?: boolean; messages?: { content: string }[] }; auth?: string }[] = [];
  const aborted: string[] = [];
  const state = { hold: undefined as Promise<void> | undefined, status: 200 };
  const app = new Hono();
  const waitOrAbort = (signal: AbortSignal, label: string) =>
    new Promise<void>((resolve, reject) => {
      if (!state.hold) return resolve();
      signal.addEventListener('abort', () => (aborted.push(label), reject(new Error('aborted'))));
      state.hold.then(resolve);
    });
  app.post('/api/chat', async (c) => {
    const body = await c.req.json();
    const label = body.messages?.[0]?.content ?? '?';
    seen.push({ path: '/api/chat', body, auth: c.req.header('authorization') });
    if (state.status !== 200) return c.text('model not found', state.status as 404);
    if (body.stream === false) {
      await waitOrAbort(c.req.raw.signal, label);
      return c.json({ message: { content: `answer to ${label}` }, done: true });
    }
    return stream(c, async (s) => {
      await s.write(`${JSON.stringify({ message: { content: 'Hel' } })}\n`);
      try {
        await waitOrAbort(c.req.raw.signal, label);
      } catch {
        return;
      }
      await s.write(`${JSON.stringify({ message: { content: 'lo' } })}\n`);
      await s.write(`${JSON.stringify({ done: true, eval_count: 2 })}\n`);
    });
  });
  app.post('/api/embed', async (c) => {
    seen.push({ path: '/api/embed', body: await c.req.json(), auth: c.req.header('authorization') });
    return c.json({ embeddings: [[0.1, 0.2]] });
  });
  app.get('/api/version', (c) => c.json({ version: '0.0-test' }));
  // Anything else reaching "Ollama" is recorded too, so a refusal can't pass for a forwarded 404.
  app.all('*', async (c) => {
    seen.push({ path: new URL(c.req.url).pathname, body: {}, auth: c.req.header('authorization') });
    return c.json({ error: 'not found' }, 404);
  });
  return { app, seen, aborted, state };
}

function setup(slots = 1) {
  const ollama = fakeOllama();
  const scheduler = createModelScheduler({ slots });
  const gateway = createGateway({
    upstream: 'http://ollama.test',
    token: TOKEN,
    scheduler,
    fetch: ((url: string, init?: RequestInit) => ollama.app.request(url, init)) as typeof fetch,
  });
  const send = (
    path: string,
    opts: { body?: object; method?: string; priority?: string; user?: number; token?: string | null; signal?: AbortSignal } = {},
  ) =>
    gateway.request(path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        ...(opts.token === null ? {} : { Authorization: `Bearer ${opts.token ?? TOKEN}` }),
        ...(opts.priority ? { 'X-Hearth-Priority': opts.priority } : {}),
        ...(opts.user !== undefined ? { 'X-Hearth-User': String(opts.user) } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  const chat = (content: string, extra: Omit<Parameters<typeof send>[1] & object, 'body'> & { stream?: boolean } = {}) =>
    send('/api/chat', { ...extra, body: { model: 'm', stream: extra.stream ?? true, messages: [{ role: 'user', content }] } });
  return { ollama, scheduler, send, chat };
}

const lines = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('the gateway token', () => {
  it('is required on every Ollama endpoint, and checked', async () => {
    const { send, chat, ollama } = setup();
    expect((await chat('hi', { token: null })).status).toBe(401);
    expect((await chat('hi', { token: 'wrong' })).status).toBe(401);
    expect((await send('/api/version', { token: null })).status).toBe(401);
    expect((await send('/api/embed', { body: { input: ['x'] }, token: 'test-tokenX' })).status).toBe(401);
    expect(ollama.seen).toEqual([]);
  });

  it('is never passed on to Ollama, and the health check needs none', async () => {
    const { send, chat, ollama } = setup();
    await (await chat('hi', { priority: 'reply' })).text();
    await send('/api/embed', { body: { model: 'e', input: ['x'] } });
    expect(ollama.seen.map((r) => r.auth)).toEqual([undefined, undefined]);
    const health = await send('/healthz', { token: null });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, slots: 1 });
  });
});

describe('proxying', () => {
  it("passes a streamed reply through line for line, as Ollama sent it", async () => {
    const { chat } = setup();
    const res = await chat('hi', { priority: 'reply', user: 1 });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await lines(res)).toEqual([{ message: { content: 'Hel' } }, { message: { content: 'lo' } }, { done: true, eval_count: 2 }]);
  });

  it('returns a non-streamed background call as Ollama answered it', async () => {
    const { chat } = setup();
    const res = await chat('summarize', { priority: 'background', stream: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: { content: 'answer to summarize' }, done: true });
  });

  it("passes Ollama's errors on", async () => {
    const { chat, ollama } = setup();
    ollama.state.status = 404;
    expect(await lines(await chat('hi', { priority: 'reply' }))).toEqual([{ error: 'Ollama returned 404: model not found' }]);
    const res = await chat('bg', { stream: false });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('model not found');
  });

  it('refuses an unknown priority, and treats a missing one as background', async () => {
    const { chat, ollama, scheduler } = setup(1);
    expect((await chat('hi', { priority: 'urgent' })).status).toBe(400);
    const held = gate();
    ollama.state.hold = held.promise;
    const running = chat('summarize', { priority: 'background', stream: false });
    await until(() => ollama.seen.length === 1);
    const unmarked = chat('no header', { stream: false });
    // As background it waits its turn; as a reply it would have preempted the running call.
    await until(() => scheduler.stats().waitingBackground === 1);
    expect(ollama.aborted).toEqual([]);
    held.open();
    expect((await running).status).toBe(200);
    expect((await unmarked).status).toBe(200);
  });

  it('passes embeddings and other endpoints straight through, even with every slot busy', async () => {
    const { chat, send, ollama } = setup();
    const held = gate();
    ollama.state.hold = held.promise;
    const busy = chat('long reply', { priority: 'reply' });
    await until(() => ollama.seen.length === 1);
    const embed = await send('/api/embed', { body: { model: 'e', input: ['bees'] } });
    expect(await embed.json()).toEqual({ embeddings: [[0.1, 0.2]] });
    expect(await (await send('/api/version')).json()).toEqual({ version: '0.0-test' });
    held.open();
    await (await busy).text();
  });
});

describe('what the gateway offers', () => {
  const offered = (path: string, method = 'POST') => ({ error: `${method} ${path} is not offered by the gateway` });

  it("refuses Ollama's model management, even with the token", async () => {
    const { send, ollama } = setup();
    const refused = [
      ['POST', '/api/pull', { model: 'registry.example/stolen-data/x' }],
      ['POST', '/api/push', { model: 'm' }],
      ['POST', '/api/create', { model: 'm', from: 'm' }],
      ['POST', '/api/copy', { source: 'm', destination: 'n' }],
      ['DELETE', '/api/delete', { model: 'm' }],
      ['POST', '/api/embeddings', { model: 'e', prompt: 'x' }], // the old endpoint; hearth uses /api/embed
    ] as const;
    for (const [method, path, body] of refused) {
      const res = await send(path, { method, body });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(offered(path, method));
    }
    expect(ollama.seen).toEqual([]);
  });

  it('refuses a listed path with the wrong method', async () => {
    const { send, ollama } = setup();
    expect(await (await send('/api/embed')).json()).toEqual(offered('/api/embed', 'GET'));
    expect(await (await send('/api/ps', { body: {} })).json()).toEqual(offered('/api/ps'));
    expect(ollama.seen).toEqual([]);
  });

  it('forwards what hearth uses and the read-only lookups', async () => {
    const { send, ollama } = setup();
    await send('/api/embed', { body: { model: 'e', input: ['x'] } });
    for (const path of ['/api/ps', '/api/tags', '/api/version']) await send(path);
    await send('/api/show', { body: { model: 'm' } });
    expect(ollama.seen.map((r) => r.path)).toEqual(['/api/embed', '/api/ps', '/api/tags', '/api/show']);
  });

  it('still asks for the token before saying what it offers', async () => {
    const { send } = setup();
    expect((await send('/api/pull', { body: { model: 'x' }, token: null })).status).toBe(401);
  });
});

describe('scheduling', () => {
  it('tells a waiting reply its place in line before Ollama starts on it', async () => {
    const { chat, ollama, scheduler } = setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const first = chat('first', { priority: 'reply', user: 1 });
    await until(() => ollama.seen.length === 1);
    const second = chat('second', { priority: 'reply', user: 2 });
    await until(() => scheduler.stats().waitingReplies === 1);
    expect(ollama.seen).toHaveLength(1); // held back here, not queued in Ollama
    held.open();
    const [, out] = await Promise.all([(await first).text(), lines(await second)]);
    expect(out[0]).toEqual({ hearth: { queued: 1 } });
    expect(out.slice(1)).toEqual([{ message: { content: 'Hel' } }, { message: { content: 'lo' } }, { done: true, eval_count: 2 }]);
  });

  it('preempts a background call for a reply: 409 "preempted", and Ollama sees the abort', async () => {
    const { chat, ollama } = setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const background = chat('extract memories', { priority: 'background', stream: false });
    await until(() => ollama.seen.length === 1);
    const reply = chat('hello', { priority: 'reply', user: 1 });
    const bg = await background;
    expect(bg.status).toBe(409);
    expect(await bg.json()).toEqual({ error: 'preempted' });
    expect(ollama.aborted).toEqual(['extract memories']);
    held.open();
    const out = await lines(await reply);
    expect(out[0]).toEqual({ message: { content: 'Hel' } }); // a slot was being freed: no "queued"
  });

  it('ends a preempted streamed background call with a "preempted" line', async () => {
    const { chat, ollama } = setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const background = await chat('describe image', { priority: 'background' });
    await until(() => ollama.seen.length === 1);
    const reply = chat('hello', { priority: 'reply', user: 1 });
    const out = await lines(background);
    expect(out.at(-1)).toEqual({ error: 'preempted' });
    held.open();
    await (await reply).text();
  });

  it('with two slots, a reply and a background call both run', async () => {
    const { chat, ollama } = setup(2);
    const held = gate();
    ollama.state.hold = held.promise;
    const background = chat('summarize', { priority: 'background', stream: false });
    const reply = chat('hello', { priority: 'reply', user: 1 });
    await until(() => ollama.seen.length === 2);
    held.open();
    expect((await background).status).toBe(200);
    expect((await lines(await reply))[0]).toEqual({ message: { content: 'Hel' } });
    expect(ollama.aborted).toEqual([]);
  });

  it('frees the slot when a client goes away mid-reply, and stops Ollama', async () => {
    const { chat, ollama, scheduler } = setup(1);
    const held = gate();
    ollama.state.hold = held.promise;
    const leaving = new AbortController();
    const res = await chat('abandoned', { priority: 'reply', user: 1, signal: leaving.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the first line arrived
    leaving.abort();
    await until(() => scheduler.stats().runningReplies === 0);
    expect(ollama.aborted).toEqual(['abandoned']);
    held.open();
    expect((await chat('next', { priority: 'reply', stream: false })).status).toBe(200);
  });
});

describe('pnpm gateway', () => {
  it('refuses to start without a token', () => {
    const r = spawnSync('node', ['server/gateway-main.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, HEARTH_GATEWAY_TOKEN: '', HEARTH_GATEWAY_PORT: '0' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HEARTH_GATEWAY_TOKEN is not set');
  });
});
