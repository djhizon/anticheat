import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { loadLocalEnv } from './env.js';

afterEach(() => vi.unstubAllEnvs());

it('loads local env files without overriding variables set in the shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
  const file = join(dir, '.env.local');
  writeFileSync(file, 'EAC_TEST_FROM_FILE=file\nEAC_TEST_SHELL=file\n');
  vi.stubEnv('EAC_TEST_SHELL', 'shell');
  vi.stubEnv('EAC_TEST_FROM_FILE', undefined);

  expect(loadLocalEnv([file, join(dir, 'missing.env')])).toEqual([file]);
  expect(process.env.EAC_TEST_FROM_FILE).toBe('file');
  expect(process.env.EAC_TEST_SHELL).toBe('shell');
});
