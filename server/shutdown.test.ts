// Graceful shutdown, tested on the real server process: hearth (server/index.ts) against a fake
// Ollama, sent SIGTERM while a reply is streaming.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const PASSWORD = 'shutdown-test-password';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** A fake Ollama whose streamed replies pause after the first chunk for `holdMs` (Infinity: forever). */
async function fakeOllama(holdMs: number) {
  const app = new Hono();
  app.post('/api/chat', async (c) => {
    const body = await c.req.json();
    if (body.stream === false) return c.json({ message: { content: 'A title' }, done: true });
    return stream(c, async (s) => {
      await s.write(`${JSON.stringify({ message: { content: 'Bon' } })}\n`);
      if (holdMs === Infinity) return new Promise<void>(() => {}); // never finishes
      await new Promise((r) => setTimeout(r, holdMs));
      await s.write(`${JSON.stringify({ message: { content: 'jour.' } })}\n`);
      await s.write(`${JSON.stringify({ done: true })}\n`);
    });
  });
  app.post('/api/embed', async (c) => {
    const { input } = await c.req.json();
    return c.json({ embeddings: (input as string[]).map(() => [1, 0]) });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  cleanups.push(() => server.close());
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Starts hearth on a temporary database with one user, and resolves once it's listening. */
async function startHearth(ollamaUrl: string, graceMs: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-stop-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HEARTH_DB_PATH: path.join(dir, 'h.db'),
    HEARTH_PORT: String(port),
    HEARTH_ORIGIN: origin,
    OLLAMA_URL: ollamaUrl,
    HEARTH_GATEWAY_URL: '',
    HEARTH_ROLE: 'all',
    HEARTH_SEARXNG_URL: 'off',
    HEARTH_SHUTDOWN_GRACE_MS: String(graceMs),
  };
  spawnSync('bin/hearth', ['users', 'add', 'alice'], { cwd: root, env, input: `${PASSWORD}\n${PASSWORD}\n` });
  const child = spawn('node', ['server/index.ts'], { cwd: root, env });
  cleanups.push(() => child.kill('SIGKILL'));
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 200 && !log.includes('hearth listening'); i++) await new Promise((r) => setTimeout(r, 25));
  expect(log).toContain('hearth listening');
  return { child, origin, log: () => log };
}

async function send(origin: string, message: string) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const chat = (await (await fetch(`${origin}/api/conversations`, { method: 'POST', headers: { ...headers, Cookie: cookie } })).json()) as { id: number };
  const res = await fetch(`${origin}/api/conversations/${chat.id}/messages`, {
    method: 'POST',
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ content: message, think: false }),
  });
  return res.body!.getReader();
}

/** Reads the reply stream to its end, calling `onDelta` at the first chunk of text. */
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, onDelta: () => void) {
  const types: string[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, i)) as { type: string };
        buffer = buffer.slice(i + 1);
        if (event.type === 'delta' && !types.includes('delta')) onDelta();
        types.push(event.type);
      }
    }
  } catch {
    types.push('(cut off)');
  }
  return types;
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', resolve)));

// Each test starts a real server process, which can take a few seconds when the whole suite runs.
describe('graceful shutdown (the real server process)', { timeout: 30_000 }, () => {
  it('lets a reply mid-stream finish after SIGTERM, refuses new connections, and exits cleanly', async () => {
    const hearth = await startHearth(await fakeOllama(800), 10_000);
    const reader = await send(hearth.origin, 'Salut !');
    let refused: string | undefined;
    const events = await readEvents(reader, () => {
      hearth.child.kill('SIGTERM');
      // A moment later the server has stopped listening: new connections are refused.
      setTimeout(() => {
        fetch(`${hearth.origin}/healthz`).then(
          () => (refused = 'accepted'),
          (err: Error & { cause?: { code?: string } }) => (refused = err.cause?.code ?? err.message),
        );
      }, 150);
    });
    expect(events).toContain('done'); // the reply finished despite the SIGTERM
    expect(await exited(hearth.child)).toBe(0);
    expect(refused).toBe('ECONNREFUSED');
    expect(hearth.log()).toMatch(/hearth: SIGTERM, finishing open requests[\s\S]*hearth: stopped/);
  });

  it('cuts off a reply still running when the grace period ends', async () => {
    const hearth = await startHearth(await fakeOllama(Infinity), 500);
    const reader = await send(hearth.origin, 'Salut !');
    const started = Date.now();
    const events = await readEvents(reader, () => hearth.child.kill('SIGTERM'));
    expect(events).not.toContain('done');
    expect(await exited(hearth.child)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hearth.log()).toContain('grace period over');
  });
});
