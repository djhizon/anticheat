import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrationDirectory = new URL('./migrations/', import.meta.url);
const migrationFilePattern = /^(\d{4})_([a-z0-9_-]+)\.sql$/u;

export function loadMigrations(): readonly Migration[] {
  return readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = migrationFilePattern.exec(entry.name);
      if (match === null) {
        return undefined;
      }

      const version = Number(match[1]);
      const name = match[2];
      if (name === undefined || !Number.isSafeInteger(version) || version <= 0) {
        return undefined;
      }

      return {
        version,
        name,
        sql: readFileSync(new URL(entry.name, migrationDirectory), 'utf8'),
      } satisfies Migration;
    })
    .filter((migration): migration is Migration => migration !== undefined)
    .sort((left, right) => left.version - right.version);
}

function orderedMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const versions = new Set<number>();

  for (const migration of ordered) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= 0 ||
      migration.name.trim() === '' ||
      versions.has(migration.version)
    ) {
      throw new Error('Migration versions must be unique positive integers.');
    }
    versions.add(migration.version);
  }

  return ordered;
}

const createLedgerSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(name) > 0),
    applied_at TEXT NOT NULL
  );
`;

/**
 * Each run records migrations in order inside the same transaction as their SQL.
 * A failed migration therefore rolls back both schema changes and its ledger entry.
 */
export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = loadMigrations(),
): void {
  const ordered = orderedMigrations(migrations);
  database.exec('BEGIN IMMEDIATE;');

  try {
    database.exec(createLedgerSql);
    const knownMigrations = new Map(ordered.map((migration) => [migration.version, migration]));
    const applied = new Map<number, string>();
    const rows = database.prepare('SELECT version, name FROM schema_migrations').all();

    for (const row of rows) {
      const version = Number(row.version);
      const name = String(row.name);
      const migration = knownMigrations.get(version);
      if (migration === undefined || migration.name !== name) {
        throw new Error('The migration ledger does not match the available migrations.');
      }
      applied.set(version, name);
    }

    let hasPendingMigration = false;
    for (const migration of ordered) {
      if (applied.has(migration.version)) {
        if (hasPendingMigration) {
          throw new Error('Migration ledger entries must form an ordered prefix.');
        }
        continue;
      }

      hasPendingMigration = true;
      database.exec(migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        )
        .run(migration.version, migration.name);
    }

    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original migration failure if rollback itself cannot run.
    }
    throw error;
  }
}
