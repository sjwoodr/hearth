import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Opens the database ready to use. By default it applies pending migrations first, as hearth always
 * has. With `autoMigrate: false` (HEARTH_AUTO_MIGRATE=0, how a deployment runs it) migrations are a
 * separate step (`pnpm migrate`, or the migrate Job), so this only checks the schema matches the
 * code and refuses to go on if it doesn't.
 */
export function openDb(file: string, opts: { autoMigrate?: boolean } = {}): DB {
  const db = connect(file);
  if (opts.autoMigrate ?? true) migrate(db);
  else checkSchema(db);
  return db;
}

/** openDb for entry points: a schema mismatch is a setup problem, so print why and exit, no stack. */
export function openDbOrExit(file: string, opts: { autoMigrate?: boolean } = {}): DB {
  try {
    return openDb(file, opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** Opens the file with hearth's settings, without touching the schema. */
export function connect(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const migrationFiles = () =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

/** The schema version this code expects: the number of its newest migration. */
export function latestVersion(): number {
  return Math.max(0, ...migrationFiles().map((f) => Number.parseInt(f, 10)));
}

export const schemaVersion = (db: DB) => db.pragma('user_version', { simple: true }) as number;

// Applies NNN_name.sql files in order, tracking progress in PRAGMA user_version. Each file runs in
// its own transaction, so a failure leaves the database at the last version that worked.
export function migrate(db: DB): { from: number; to: number } {
  const from = schemaVersion(db);
  for (const file of migrationFiles()) {
    const version = Number.parseInt(file, 10);
    if (version <= from) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
  return { from, to: schemaVersion(db) };
}

/** Throws unless the database is at exactly the version this code expects. */
export function checkSchema(db: DB): void {
  const current = schemaVersion(db);
  const latest = latestVersion();
  if (current < latest) {
    throw new Error(
      `The database schema is at version ${current}, but this hearth needs ${latest}. ` +
        'Run the migrations first (`pnpm migrate`, or the migrate Job), or set HEARTH_AUTO_MIGRATE=1.',
    );
  }
  if (current > latest) {
    throw new Error(
      `The database schema is at version ${current}, newer than this hearth knows (${latest}). ` +
        'Run the newer hearth, or restore a backup from before the upgrade (migrations only go forward).',
    );
  }
}
