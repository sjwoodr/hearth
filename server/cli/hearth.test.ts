import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '../../bin/hearth');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-cli-'));
const env = { ...process.env, HEARTH_DB_PATH: path.join(dir, 'test.db') };

function hearth(args: string[], input = '') {
  const r = spawnSync(BIN, args, { input, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('hearth CLI (piped input)', () => {
  it('adds a user from two piped password lines', () => {
    const r = hearth(['users', 'add', 'alex'], 'goodpassword\ngoodpassword\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Created user "alex"');
    expect(hearth(['users', 'list']).out).toMatch(/alex\s+-\s+active/);
  });

  it('sets and clears a display name', () => {
    expect(hearth(['users', 'name', 'alex', 'Alex', 'W']).out).toContain('is now called "Alex W"');
    expect(hearth(['users', 'list']).out).toMatch(/alex\s+Alex W\s+active/);
    expect(hearth(['users', 'name', 'alex', '']).out).toContain('uses their username again');
  });

  it('fails loudly on a short or mismatched password', () => {
    expect(hearth(['users', 'add', 'bob'], 'short\n').code).toBe(1);
    expect(hearth(['users', 'add', 'bob'], 'goodpassword\nother password\n').code).toBe(1);
    expect(hearth(['users', 'list']).out).not.toContain('bob');
  });

  it('manages memories end to end', () => {
    expect(hearth(['memories', 'add', 'alex', 'fact', 'Likes', 'HF', 'contesting']).code).toBe(0);
    expect(hearth(['memories', 'edit', '1', 'Likes CW contesting']).code).toBe(0);
    expect(hearth(['memories', 'kind', '1', 'profile']).code).toBe(0);
    expect(hearth(['memories', 'list', 'alex']).out).toMatch(/#1\s+alex\s+·\s+profile\s+·\s+Likes CW contesting/);
    expect(hearth(['memories', 'delete', '1'], 'n\n').out).toContain('Cancelled');
    expect(hearth(['memories', 'delete', '1', '--yes']).code).toBe(0);
    expect(hearth(['memories', 'list']).out).toContain('No memories.');
  });

  it('refuses to delete a user unless the name is typed back', () => {
    expect(hearth(['users', 'delete', 'alex'], 'wrong\n').out).toContain('Not deleted');
    expect(hearth(['users', 'list']).out).toContain('alex');
  });

  it('reports unknown commands with a non-zero exit', () => {
    const r = hearth(['bogus']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown command');
  });
});

describe('hearth chats stats', () => {
  it('counts replies per week that end with a question, with lengths', async () => {
    expect(hearth(['users', 'add', 'statsy'], 'goodpassword\ngoodpassword\n').code).toBe(0);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(env.HEARTH_DB_PATH);
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'statsy'").get() as { id: number }).id;
    const chat = Number(db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid);
    const say = (role: string, content: string, at: string) =>
      db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chat, role, content, at);
    // Monday 2026-10-26 and the Sunday that ends the same week; then the next week.
    say('user', 'Hi there!', '2026-10-26 09:00:00');
    say('assistant', 'Hello. How was your day?', '2026-10-26 09:00:05');
    say('user', 'Fine.', '2026-11-01 20:00:00');
    say('assistant', 'Good to hear. **Anything planned?**\n', '2026-11-01 20:00:05');
    say('user', 'Tell me a fact.', '2026-11-02 08:00:00');
    say('assistant', 'Octopuses have three hearts.', '2026-11-02 08:00:05');
    db.close();

    const out = hearth(['chats', 'stats', 'statsy']).out.split('\n');
    expect(out[0]).toMatch(/^WEEK OF\s+REPLIES\s+END IN \?/);
    // Week one: both replies end with a question (the second behind Markdown); week two: none.
    expect(out[1]).toMatch(/^2026-10-26\s+2\s+100%\s+30\s+7\s+4\.3x$/);
    expect(out[2]).toMatch(/^2026-11-02\s+1\s+0%\s+28\s+15\s+1\.9x$/);
    expect(hearth(['chats', 'stats', 'alex']).out).not.toContain('2026-10-26');
  });
});

describe('hearth memories recall', () => {
  it('goes through the gateway when one is set, as it must inside the cluster', async () => {
    expect(hearth(['users', 'add', 'recaller'], 'goodpassword\ngoodpassword\n').code).toBe(0);
    expect(hearth(['memories', 'add', 'recaller', 'fact', 'Plays', 'the', 'banjo']).code).toBe(0);
    const seen: { path?: string; auth?: string }[] = [];
    const gateway = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ path: req.url, auth: req.headers.authorization });
        const { input } = JSON.parse(body) as { input: string[] };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ embeddings: input.map(() => [1, 0, 0]) }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const { port } = gateway.address() as { port: number };
    // Async spawn: the fake gateway answers from this process's event loop.
    const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(BIN, ['memories', 'recall', 'recaller', 'any', 'hobbies?'], {
        env: {
          ...env,
          HEARTH_GATEWAY_URL: `http://127.0.0.1:${port}`,
          HEARTH_GATEWAY_TOKEN: 'cli-token',
          HEARTH_OLLAMA_URL: 'http://127.0.0.1:9',
        },
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.on('close', (code) => resolve({ code, out: text }));
    });
    gateway.close();
    expect(out.code).toBe(0);
    expect(out.out).toMatch(/1\.000 ✓ #\d+ Plays the banjo/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.path === '/api/embed' && r.auth === 'Bearer cli-token')).toBe(true);
  });
});
