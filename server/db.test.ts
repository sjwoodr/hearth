import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSchema, connect, latestVersion, migrate, openDb, schemaVersion } from './db.ts';

const root = path.resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A database file in a throwaway folder, never the real one. */
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-db-'));
  dirs.push(dir);
  return path.join(dir, 'hearth.db');
}

/** Runs a hearth command against `file`, with the environment winning over the repo's .env. */
function run(args: string[], file: string, env: Record<string, string> = {}) {
  const r = spawnSync(args[0]!, args.slice(1), {
    cwd: root,
    env: { ...process.env, HEARTH_DB_PATH: file, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('opening the database', () => {
  it('migrates on open by default, as hearth always has', () => {
    const db = openDb(':memory:');
    expect(schemaVersion(db)).toBe(latestVersion());
  });

  it('only checks the schema when auto-migrate is off, and refuses one that is behind', () => {
    expect(() => openDb(':memory:', { autoMigrate: false })).toThrow(
      new RegExp(`version 0, but this hearth needs ${latestVersion()}.*pnpm migrate`),
    );
  });

  it('opens a migrated database with auto-migrate off', () => {
    const file = tempDb();
    openDb(file).close();
    const db = openDb(file, { autoMigrate: false });
    expect(schemaVersion(db)).toBe(latestVersion());
    db.close();
  });

  it('refuses a database newer than the code when checking, but auto-migrate still opens it', () => {
    const db = openDb(':memory:');
    db.pragma(`user_version = ${latestVersion() + 1}`);
    expect(() => checkSchema(db)).toThrow(/newer than this hearth knows.*restore a backup/);
    // Auto-migrate keeps today's behaviour (switching to an older branch in dev still starts).
    expect(migrate(db)).toEqual({ from: latestVersion() + 1, to: latestVersion() + 1 });
  });

  it('migrate reports what it did, and does nothing the second time', () => {
    const db = connect(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: latestVersion() });
    expect(migrate(db)).toEqual({ from: latestVersion(), to: latestVersion() });
  });
});

describe('pnpm migrate (server/migrate.ts)', () => {
  it('migrates a new database, then says there is nothing to do', () => {
    const file = tempDb();
    const first = run(['node', 'server/migrate.ts'], file);
    expect(first).toEqual({ status: 0, out: `Migrated the schema from version 0 to ${latestVersion()}.\n` });
    const second = run(['node', 'server/migrate.ts'], file);
    expect(second).toEqual({ status: 0, out: `Schema already at version ${latestVersion()}.\n` });
  });

  it('fails without touching a database newer than its migrations', () => {
    const file = tempDb();
    const db = openDb(file);
    db.pragma(`user_version = ${latestVersion() + 1}`);
    db.close();
    const r = run(['node', 'server/migrate.ts'], file);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/newer than these migrations/);
    const after = connect(file);
    expect(schemaVersion(after)).toBe(latestVersion() + 1);
    after.close();
  });
});

describe('HEARTH_AUTO_MIGRATE', () => {
  it('=0 makes bin/hearth refuse an unmigrated database, then work once it is migrated', () => {
    const file = tempDb();
    const refused = run(['bin/hearth', 'db', 'info'], file, { HEARTH_AUTO_MIGRATE: '0' });
    expect(refused.status).not.toBe(0);
    expect(refused.out).toMatch(/needs \d+\. Run the migrations first/);

    run(['node', 'server/migrate.ts'], file);
    const ok = run(['bin/hearth', 'db', 'info'], file, { HEARTH_AUTO_MIGRATE: '0' });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(`Schema version: ${latestVersion()}`);
  });

  it('unset, migrates on start as before', () => {
    const file = tempDb();
    const r = run(['bin/hearth', 'db', 'info'], file, { HEARTH_AUTO_MIGRATE: '' });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Schema version: ${latestVersion()}`);
  });
});
