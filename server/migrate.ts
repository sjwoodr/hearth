// Applies pending migrations to HEARTH_DB_PATH and exits: `pnpm migrate` by hand, and in a
// deployment the migrate Job (`node server/migrate.ts`) that runs before hearth starts, so the
// app itself can run with HEARTH_AUTO_MIGRATE=0 and only check the schema.
import { config } from './config.ts';
import { setLogFormat } from './logging.ts';
import { connect, latestVersion, migrate, schemaVersion } from './db.ts';

setLogFormat(config.logFormat, 'migrate');

const db = connect(config.dbPath);
try {
  const latest = latestVersion();
  const before = schemaVersion(db);
  if (before > latest) {
    console.error(
      `The database schema is at version ${before}, newer than these migrations (${latest}). ` +
        'Nothing to do here; run the newer hearth, or restore a backup from before the upgrade.',
    );
    process.exitCode = 1;
  } else {
    const { from, to } = migrate(db);
    console.log(from === to ? `Schema already at version ${to}.` : `Migrated the schema from version ${from} to ${to}.`);
  }
} catch (err) {
  console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  db.close();
}
