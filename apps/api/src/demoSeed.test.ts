import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedDemo, seedDemoOnce } from './demoSeed.js';

const directories: string[] = [];
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'eac-seed-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('seedDemoOnce', () => {
  it('seeds once and then skips while the marker exists', async () => {
    const marker = join(tempDir(), 'data', 'seeded');
    const seed = vi.fn(() => Promise.resolve());

    expect(await seedDemoOnce(marker, seed)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(await seedDemoOnce(marker, seed)).toBe(false);
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('does not write the marker when seeding fails, so it is retried', async () => {
    const marker = join(tempDir(), 'seeded');
    const seed = vi.fn(() => Promise.reject(new Error('boom')));

    await expect(seedDemoOnce(marker, seed)).rejects.toThrow('boom');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('seedDemo', () => {
  it('refuses to run in production', async () => {
    await expect(seedDemo({ env: { NODE_ENV: 'production' } })).rejects.toThrow(
      'The demo seed is disabled in production.',
    );
  });

  it('creates the demo accounts in the configured database', async () => {
    const databasePath = join(tempDir(), 'seed.sqlite');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await seedDemo({ env: { DATABASE_PATH: databasePath, GEMINI_API_KEYS: '' } });
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
