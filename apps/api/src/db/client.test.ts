import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './client.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('database client', () => {
  it('creates the configured parent for a nested filesystem database', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'examguard-db-'));
    temporaryDirectories.push(temporaryDirectory);
    const databasePath = join(temporaryDirectory, 'nested', 'state.sqlite');

    const database = openDatabase(databasePath);
    try {
      expect(existsSync(databasePath)).toBe(true);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(),
      ).toBeDefined();
    } finally {
      database.close();
    }
  });

  it('preserves in-memory and SQLite URI database behavior', () => {
    const memoryDatabase = openDatabase(':memory:');
    const uriDatabase = openDatabase('file:examguard-shared?mode=memory&cache=shared');

    try {
      expect(
        memoryDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(),
      ).toBeDefined();
      expect(
        uriDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(),
      ).toBeDefined();
    } finally {
      memoryDatabase.close();
      uriDatabase.close();
    }
  });
});
