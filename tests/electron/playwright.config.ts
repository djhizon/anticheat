import { defineConfig } from '@playwright/test';

// macOS GUI test of the real Electron app (dev build and packaged judge build). Not run in CI.
// The app needs exactly 127.0.0.1:3000 and :5173, so tests run serially and wait for them.
export default defineConfig({
  testDir: '.',
  testMatch: 'app.spec.ts',
  outputDir: '../../test-results/electron/artifacts',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
});
