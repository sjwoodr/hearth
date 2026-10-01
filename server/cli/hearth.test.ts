import { spawnSync } from 'node:child_process';
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
