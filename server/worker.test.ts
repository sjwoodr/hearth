import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreemptedError } from './busy.ts';
import { openDb, type DB } from './db.ts';
import type { JsonFn } from './ollama.ts';
import { backgroundJobs } from './models.ts';
import { createSummarySweep } from './summarize.ts';

const root = path.resolve(import.meta.dirname, '..');
// A small window, so a few messages make a chat "long": summarize above 200 tokens, keep 100.
const NUM_CTX = 400;

function chatDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'x')").run();
  return db;
}

function newChat(db: DB): number {
  return Number(db.prepare('INSERT INTO conversations (user_id) VALUES (1)').run().lastInsertRowid);
}

/** Adds an exchange of about 90 tokens a message. */
function exchange(db: DB, chat: number, n = 1) {
  for (let i = 0; i < n; i++) {
    const add = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)');
    add.run(chat, 'user', `Question ${i}: ${'tell me about bees and their hives, please. '.repeat(7)}`);
    add.run(chat, 'assistant', `Answer ${i}: ${'bees live in colonies with a queen and workers. '.repeat(7)}`);
  }
}

const summaryOf = (db: DB, chat: number) =>
  (db.prepare('SELECT summary FROM conversations WHERE id = ?').get(chat) as { summary: string | null }).summary;

function fakeModel() {
  const calls: number[] = [];
  let outcome: 'ok' | 'preempt' = 'ok';
  const json: JsonFn = async () => {
    calls.push(calls.length);
    if (outcome === 'preempt') throw new PreemptedError();
    return 'They talked about bees.';
  };
  return { json, calls, set: (o: 'ok' | 'preempt') => (outcome = o) };
}

describe('the summary sweep (the worker finds long chats itself)', () => {
  it('summarizes a long chat with new replies, once', async () => {
    const db = chatDb();
    const chat = newChat(db);
    exchange(db, chat, 4);
    const model = fakeModel();
    const sweep = createSummarySweep(db, model.json, NUM_CTX);
    await sweep();
    expect(summaryOf(db, chat)).toBe('They talked about bees.');
    expect(model.calls).toHaveLength(1);
    await sweep(); // nothing new since
    expect(model.calls).toHaveLength(1);
  });

  it("leaves short chats alone, without asking the model", async () => {
    const db = chatDb();
    exchange(db, newChat(db), 1);
    const model = fakeModel();
    await createSummarySweep(db, model.json, NUM_CTX)();
    expect(model.calls).toEqual([]);
  });

  it('looks at a chat again only after a new reply in it', async () => {
    const db = chatDb();
    const [a, b] = [newChat(db), newChat(db)];
    exchange(db, a, 4);
    exchange(db, b, 1);
    const model = fakeModel();
    const sweep = createSummarySweep(db, model.json, NUM_CTX);
    await sweep();
    expect(model.calls).toHaveLength(1); // only the long chat
    db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'a question with no reply yet')").run(b);
    await sweep();
    expect(model.calls).toHaveLength(1); // a user message alone isn't a reason to look
    exchange(db, b, 4); // now b is long, with new replies
    await sweep();
    expect(model.calls).toHaveLength(2);
    expect(summaryOf(db, b)).toBe('They talked about bees.');
  });

  it('retries a summary preempted for a reply on the next pass, with no new replies', async () => {
    const db = chatDb();
    const chat = newChat(db);
    exchange(db, chat, 4);
    const model = fakeModel();
    const sweep = createSummarySweep(db, model.json, NUM_CTX);
    model.set('preempt');
    await sweep();
    expect(summaryOf(db, chat)).toBeNull();
    model.set('ok');
    await sweep();
    expect(summaryOf(db, chat)).toBe('They talked about bees.');
  });

  it("leaves a chat whose summary failed until its next reply, as today", async () => {
    const db = chatDb();
    const chat = newChat(db);
    exchange(db, chat, 4);
    let reply = ''; // an empty summary is an error, not a preemption
    const calls: string[] = [];
    const json: JsonFn = async () => (calls.push(reply), reply);
    const sweep = createSummarySweep(db, json, NUM_CTX);
    await sweep();
    expect(calls).toHaveLength(1);
    reply = 'They talked about bees.';
    await sweep(); // no new reply: not tried again
    expect(calls).toHaveLength(1);
    exchange(db, chat, 1); // a new reply: worth another try
    await sweep();
    expect(calls).toHaveLength(2);
    expect(summaryOf(db, chat)).toBe('They talked about bees.');
  });
});

describe('which background jobs the main process runs', () => {
  it('all of them by default; with HEARTH_ROLE=api, memories and summaries are the worker\'s', () => {
    expect(backgroundJobs('all')).toEqual({ memories: true, summariesAfterReply: true });
    expect(backgroundJobs('api')).toEqual({ memories: false, summariesAfterReply: false });
  });
});

describe('starting the api and the worker as separate processes', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function env(extra: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-role-'));
    dirs.push(dir);
    return { ...process.env, HEARTH_DB_PATH: path.join(dir, 'h.db'), HEARTH_GATEWAY_URL: '', HEARTH_GATEWAY_TOKEN: '', ...extra };
  }
  const run = (file: string, extra: Record<string, string>) =>
    spawnSync('node', [file], { cwd: root, env: env(extra), encoding: 'utf8', timeout: 15_000 });

  it('refuses either one without the gateway, saying why', () => {
    for (const r of [run('server/index.ts', { HEARTH_ROLE: 'api' }), run('server/worker.ts', {})]) {
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/needs the model gateway.*would never yield/);
    }
  });

  it('refuses a HEARTH_TRUSTED_PROXIES it can\'t read, rather than trusting the wrong proxies', () => {
    const r = run('server/index.ts', { HEARTH_TRUSTED_PROXIES: '10.42.0.0/16, 10.43.0.0/99' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`can't read "10.43.0.0/99"`);
  });

  it('refuses an unknown role, and a gateway URL without a token', () => {
    const bad = run('server/index.ts', { HEARTH_ROLE: 'worker' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('HEARTH_ROLE must be "all" or "api"');
    const noToken = run('server/worker.ts', { HEARTH_GATEWAY_URL: 'http://127.0.0.1:1' });
    expect(noToken.status).toBe(1);
    expect(noToken.stderr).toContain('HEARTH_GATEWAY_TOKEN is not');
  });

  /**
   * Starts an entry point, resolves with the first line of its output matching `want`, then stops
   * it. Matching rather than taking the first line: startup can print other lines first (on CI,
   * with no built front end, a warning about the missing dist/client).
   */
  function lineMatching(file: string, extra: Record<string, string>, want: RegExp) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn('node', [file], { cwd: root, env: env(extra) });
      let out = '';
      const done = (line: string) => {
        child.kill();
        resolve(line);
      };
      const look = (d: Buffer) => {
        out += d;
        const line = out.split('\n').find((l) => want.test(l));
        if (line) done(line);
      };
      child.stdout.on('data', look);
      child.stderr.on('data', look);
      child.on('exit', (code) => (code ? reject(new Error(`exited ${code}: ${out}`)) : resolve(out)));
      setTimeout(() => done(out), 10_000);
    });
  }

  it('starts both with the gateway: the api says the worker has the background jobs', async () => {
    const gateway = { HEARTH_GATEWAY_URL: 'http://127.0.0.1:1', HEARTH_GATEWAY_TOKEN: 't', HEARTH_WORKER_PORT: '0' };
    expect(await lineMatching('server/worker.ts', gateway, /hearth worker running/)).toMatch(/^hearth worker running: memories after .* via the gateway/);
    expect(await lineMatching('server/index.ts', { ...gateway, HEARTH_ROLE: 'api', HEARTH_PORT: '0' }, /hearth listening/)).toMatch(
      /api only: the worker extracts memories and summarizes/,
    );
  });
});
