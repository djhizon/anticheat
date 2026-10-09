/* global process, console */
// Starts an isolated API for the demo E2E: temp database, seeded demo data, no cloud keys.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiPort = process.env.E2E_API_PORT ?? '3100';
const webPort = process.env.E2E_WEB_PORT ?? '5273';
const databasePath = join(tmpdir(), `exam-e2e-demo-${apiPort}.sqlite`);
for (const suffix of ['', '-wal', '-shm', '-journal'])
  rmSync(databasePath + suffix, { force: true });

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: apiPort,
  DATABASE_PATH: databasePath,
  ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  // Cloud features stay off: empty shell values win over any .env.local.
  GEMINI_API_KEYS: '',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ENABLE_BACKEND_VISION: 'false',
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const seed = spawnSync(npm, ['run', 'demo:seed'], { env, stdio: 'inherit' });
if (seed.status !== 0) {
  console.error('Demo seed failed.');
  process.exit(seed.status ?? 1);
}
const api = spawn(npm, ['run', 'dev:api'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => api.kill(signal));
api.once('exit', (code) => process.exit(code ?? 0));
