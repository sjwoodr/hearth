import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db.ts';
import { probeModels, registerHealthRoutes } from './health.ts';
import { setupApp } from './testing.ts';

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(app: Hono) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('health endpoints', () => {
  it('need no login: /healthz says the process is up, /readyz checks the database', async () => {
    const { app } = setupApp();
    const live = await app.request('/healthz');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, checks: { database: 'ok' } });
  });

  it('are not ready when the schema doesn\'t match the code', async () => {
    const db = openDb(':memory:');
    db.pragma('user_version = 1'); // as if migrations hadn't run
    const app = new Hono();
    registerHealthRoutes(app, { db });
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ready: false, checks: { database: expect.stringMatching(/needs \d+/) } });
  });

  it('report unreachable models without failing readiness', async () => {
    const app = new Hono();
    registerHealthRoutes(app, { db: openDb(':memory:'), models: async () => 'gateway unreachable: connection refused' });
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, checks: { database: 'ok', models: 'gateway unreachable: connection refused' } });
  });
});

describe('probing the models', () => {
  it("asks the gateway's /healthz, or Ollama's /api/version", async () => {
    const fake = new Hono();
    fake.get('/healthz', (c) => c.json({ ok: true }));
    fake.get('/api/version', (c) => c.json({ version: 'x' }));
    const url = await listen(fake);
    expect(await probeModels(url, true)()).toBeUndefined();
    expect(await probeModels(url, false)()).toBeUndefined();
    const onlyOllama = new Hono();
    onlyOllama.get('/api/version', (c) => c.json({ version: 'x' }));
    expect(await probeModels(await listen(onlyOllama), true)()).toBe('gateway returned 404');
  });

  it("says when nothing answers, and doesn't hang on a dependency that never replies", async () => {
    expect(await probeModels('http://127.0.0.1:1', false)()).toMatch(/^Ollama unreachable/);
    const hung = new Hono();
    hung.get('/healthz', () => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await probeModels(await listen(hung), true, 200)()).toMatch(/^gateway unreachable/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
