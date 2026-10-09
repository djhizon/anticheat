import { defineConfig, devices } from '@playwright/test';

const apiPort = process.env.E2E_API_PORT ?? '3100';
const webPort = process.env.E2E_WEB_PORT ?? '5273';
const sharedEnv = { E2E_API_PORT: apiPort, E2E_WEB_PORT: webPort };

// Isolated ports and a temp database: never touches a developer's `npm run demo` on 3000/5173.
export default defineConfig({
  testDir: '.',
  testMatch: 'demo-flow.spec.ts',
  outputDir: '../../test-results/demo-e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-fake-media',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
          ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
            : {}),
        },
      },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/start-api.mjs',
      cwd: '../..',
      url: `http://127.0.0.1:${apiPort}/auth/csrf`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: sharedEnv,
    },
    {
      command:
        'npm run vision:prepare && npm run dev --workspace @exam-anti-cheat/web -- --config ../../tests/e2e/vite.e2e.config.ts',
      cwd: '../..',
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: sharedEnv,
    },
  ],
});
