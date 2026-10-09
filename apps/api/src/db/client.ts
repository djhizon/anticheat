import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';

import { applyMigrations } from './migrate.js';

function ensureDatabaseParent(databasePath: string): void {
  // SQLite URI filenames and :memory: have their own semantics; do not turn them into paths.
  if (databasePath === ':memory:' || databasePath.startsWith('file:')) {
    return;
  }

  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
}

export function openDatabase(databasePath: string): DatabaseSync {
  const normalizedPath = databasePath.trim();
  if (normalizedPath === '') {
    throw new Error('A database path is required.');
  }

  ensureDatabaseParent(normalizedPath);
  const database = new DatabaseSync(normalizedPath);

  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
