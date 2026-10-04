import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelScheduler, PreemptedError } from './busy.ts';
import { openDb } from './db.ts';
import { createGateway } from './gateway.ts';
import { registry } from './metrics.ts';
import { ollamaChat, ollamaJson } from './ollama.ts';
import { createSummarySweep } from './summarize.ts';
import { ORIGIN, setupApp, signIn } from './testing.ts';

// The registry is shared by every test in the process, so each test reads a counter before and
// after and checks the difference.
async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want))
    .reduce((sum, v) => sum + v.value, 0);
}
const delta = async (name: string, labels: Record<string, string>, act: () => Promise<unknown>) => {
  const before = await value(name, labels);
  await act();
  return (await value(name, labels)) - before;
};

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function newChat(app: ReturnType<typeof setupApp>['app'], cookie: string) {
  const res = await app.request('/api/conversations', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
  return ((await res.json()) as { id: number }).id;
}
const post = async (app: ReturnType<typeof setupApp>['app'], cookie: string, path: string, body: object) =>
  (
    await app.request(`/api${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).text();

/** One part of a histogram (`_sum`, `_count`) for some labels. The library's types omit metricName. */
async function histogramPart(name: string, part: 'sum' | 'count', labels: Record<string, string> = {}) {
  const { values } = await registry.getSingleMetric(name)!.get();
  return (values as { value: number; labels: Record<string, string | number>; metricName?: string }[])
    .filter((v) => v.metricName === `${name}_${part}` && Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want))
    .reduce((sum, v) => sum + v.value, 0);
}

describe('reply and search metrics', () => {
  it('count a finished reply and time it', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'steve');
    const id = await newChat(ctx.app, cookie);
    const done = { outcome: 'done', think: 'false' };
    const [firsts, totals] = [
      await histogramPart('hearth_reply_first_token_seconds', 'count', { think: 'false' }),
      await histogramPart('hearth_reply_seconds', 'count', { think: 'false' }),
    ];
    expect(await delta('hearth_replies_total', done, () => post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'Salut' }))).toBe(1);
    expect(await histogramPart('hearth_reply_first_token_seconds', 'count', { think: 'false' })).toBe(firsts + 1);
    expect(await histogramPart('hearth_reply_seconds', 'count', { think: 'false' })).toBe(totals + 1);
  });

  it('count a failed reply as an error, and titles by outcome', async () => {
    const ctx = setupApp();
    const cookie = await signIn(ctx, 'steve');
    ctx.model.title = 'Bees';
    const id = await newChat(ctx.app, cookie);
    expect(await delta('hearth_background_jobs_total', { job: 'title', outcome: 'ok' }, () => post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'Bees?' }))).toBe(1);
    ctx.model.reply = ['Half', new Error('model crashed')];
    expect(await delta('hearth_replies_total', { outcome: 'error' }, () => post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'And?' }))).toBe(1);
  });

  it('count searches asked for, approved, declined and failed', async () => {
    const ctx = setupApp({ webSearch: true });
    const cookie = await signIn(ctx, 'steve');
    const id = await newChat(ctx.app, cookie);
    const ask = () => {
      ctx.model.asks.push('fishbach tour');
      return post(ctx.app, cookie, `/conversations/${id}/messages`, { content: 'Tour dates?' });
    };
    expect(await delta('hearth_searches_total', { outcome: 'asked' }, ask)).toBe(1);
    expect(await delta('hearth_searches_total', { outcome: 'approved' }, () => post(ctx.app, cookie, `/conversations/${id}/search`, { approve: true }))).toBe(1);
    await ask();
    expect(await delta('hearth_searches_total', { outcome: 'declined' }, () => post(ctx.app, cookie, `/conversations/${id}/search`, { approve: false }))).toBe(1);
    await ask();
    ctx.model.results = new Error('SearXNG down');
    expect(await delta('hearth_searches_total', { outcome: 'failed' }, () => post(ctx.app, cookie, `/conversations/${id}/search`, { approve: true }))).toBe(1);
  });
});

describe('scheduler metrics', () => {
  it('report waits, preemptions and overdue background calls through hooks', async () => {
    const started: [string, number][] = [];
    let preempted = 0;
    let overdue = 0;
    let clock = 0;
    const scheduler = createModelScheduler({
      now: () => clock,
      backgroundMaxWaitMs: 100,
      onStart: (kind, waited) => started.push([kind, waited]),
      onPreempt: () => preempted++,
      onOverdue: () => overdue++,
    });
    const hang = scheduler.background((_m, _s, signal) => new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    const job = hang([], null);
    let release!: () => void;
    const reply = (async () => {
      for await (const _ of scheduler.chat(async function* () {
        await new Promise<void>((r) => (release = r));
        yield 'x';
      })([], new AbortController().signal)) void _;
    })();
    await expect(job).rejects.toBeInstanceOf(PreemptedError);
    expect(preempted).toBe(1);
    // A background call queued behind the reply, waiting past its limit.
    const later = scheduler.background(async () => 'ok')([], null);
    clock = 150;
    release();
    await reply;
    await later;
    expect(overdue).toBe(1);
    expect(started.map(([kind]) => kind)).toEqual(['background', 'reply', 'background']);
    expect(started.at(-1)![1]).toBe(150); // it waited 150 ms on the fake clock
  });
});

describe('model metrics from Ollama\'s timings', () => {
  it('record tokens per second and prompt reading time, for replies and background calls', async () => {
    const fake = new Hono();
    fake.post('/api/chat', async (c) => {
      const body = await c.req.json();
      const stats = { eval_count: 50, eval_duration: 2e9, prompt_eval_duration: 3e8 }; // 25 tok/s, 0.3 s
      if (body.stream === false) return c.json({ message: { content: 'ok' }, done: true, ...stats });
      return c.body(`${JSON.stringify({ message: { content: 'Hi' } })}\n${JSON.stringify({ done: true, ...stats })}\n`);
    });
    const server = serve({ fetch: fake.fetch, hostname: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const replyTokens = await delta('hearth_model_tokens_total', { kind: 'reply' }, async () => {
      for await (const _ of ollamaChat(url, 'm', 1024)([{ role: 'user', content: 'x' }], new AbortController().signal)) void _;
    });
    expect(replyTokens).toBe(50);
    expect(await delta('hearth_model_tokens_total', { kind: 'background' }, () => ollamaJson(url, 'm', 1024)([{ role: 'user', content: 'x' }], null))).toBe(50);
    // Every observation in this test is 25 tok/s and 0.3 s, whatever ran before it.
    const speed = await histogramPart('hearth_model_tokens_per_second', 'sum', { kind: 'reply' });
    expect(speed / (await histogramPart('hearth_model_tokens_per_second', 'count', { kind: 'reply' }))).toBeCloseTo(25);
    expect(await histogramPart('hearth_model_prompt_seconds', 'sum', { kind: 'background' })).toBeCloseTo(0.3);
  });
});

describe('background job metrics', () => {
  it('count summaries by outcome', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x')").run();
    db.prepare('INSERT INTO conversations (id, user_id) VALUES (1, 1)').run();
    for (let i = 0; i < 8; i++) {
      db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (1, ?, ?)").run(i % 2 ? 'assistant' : 'user', 'bees and hives. '.repeat(30));
    }
    let preempt = true;
    const sweep = createSummarySweep(db, async () => {
      if (preempt) throw new PreemptedError();
      return 'About bees.';
    }, 400);
    expect(await delta('hearth_background_jobs_total', { job: 'summary', outcome: 'preempted' }, sweep)).toBe(1);
    preempt = false;
    expect(await delta('hearth_background_jobs_total', { job: 'summary', outcome: 'ok' }, sweep)).toBe(1);
  });
});

describe('/metrics', () => {
  it('serves Prometheus text on the api without a login', async () => {
    const { app } = setupApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('# TYPE hearth_replies_total counter');
  });

  it('needs the token on the gateway', async () => {
    const gateway = createGateway({ upstream: 'http://unused', token: 'tok', scheduler: createModelScheduler() });
    expect((await gateway.request('/metrics')).status).toBe(401);
    const ok = await gateway.request('/metrics', { headers: { Authorization: 'Bearer tok' } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('hearth_model_preemptions_total');
  });
});
