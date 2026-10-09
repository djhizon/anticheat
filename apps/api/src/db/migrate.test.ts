import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { applyMigrations, loadMigrations, type Migration } from './migrate.js';

describe('database migrations', () => {
  it('records ordered versions and is safe to rerun', () => {
    const database = new DatabaseSync(':memory:');

    try {
      const migrations = loadMigrations();
      applyMigrations(database, migrations);
      applyMigrations(database, migrations);

      const rows = database
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all();
      expect(rows).toEqual([
        { version: 1, name: 'identity' },
        { version: 2, name: 'exam_delivery' },
        { version: 3, name: 'exam_answers' },
        { version: 4, name: 'integrity' },
        { version: 5, name: 'phone_presence' },
        { version: 6, name: 'supabase_identity' },
      ]);
    } finally {
      database.close();
    }
  });

  it('rolls back schema and ledger changes when a migration fails', () => {
    const database = new DatabaseSync(':memory:');
    const failingMigrations: readonly Migration[] = [
      { version: 1, name: 'first', sql: 'CREATE TABLE first_table (id INTEGER NOT NULL);' },
      { version: 2, name: 'broken', sql: 'CREATE TABLE broken_table (' },
    ];

    try {
      expect(() => applyMigrations(database, failingMigrations)).toThrow();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      expect(tables).toEqual([]);
    } finally {
      database.close();
    }
  });
});
