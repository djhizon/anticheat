/* global console, process, fetch, setTimeout, setInterval, clearInterval, clearTimeout */
// Smoke test for apps/api/dist/api-server.mjs: starts it twice on a temp data dir, checks the
// demo login (through the web-port proxy) and that the second start does not re-seed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(root, 'apps/api/dist/api-server.mjs');
if (!existsSync(bundle)) {
  console.error('Missing bundle; run `npm run build:bundle --workspace @exam-anti-cheat/api`.');
  process.exit(1);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const temp = mkdtempSync(join(tmpdir(), 'eac-bundle-smoke-'));
const webRoot = join(temp, 'web');
mkdirSync(webRoot, { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>smoke</title>');
const apiPort = await freePort();
const webPort = await freePort();
const origin = 'http://127.0.0.1:5173';

function startServer() {
  const env = { ...process.env };
  delete env.NODE_ENV;
  Object.assign(env, {
    DATABASE_PATH: join(temp, 'data', 'exam.sqlite'),
    SERVE_WEB_DIST: webRoot,
    API_PORT: String(apiPort),
    WEB_PORT: String(webPort),
    GEMINI_API_KEYS: '',
  });
  const child = spawn(process.execPath, [bundle], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server not ready:\n${output}`)), 60000);
    const check = setInterval(() => {
      if (output.includes('desktop server ready')) {
        clearInterval(check);
        clearTimeout(timer);
        resolveReady();
      }
    }, 100);
    child.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}):\n${output}`));
    });
  });
  const stop = () =>
    new Promise((resolveStop) => {
      if (child.exitCode !== null) return resolveStop();
      child.once('exit', () => resolveStop());
      child.kill('SIGTERM');
    });
  return { ready, stop, output: () => output };
}

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function login(email, password) {
  const csrfResponse = await fetch(`http://127.0.0.1:${webPort}/auth/csrf`, {
    headers: { Origin: origin },
  });
  const { csrfToken } = await csrfResponse.json();
  const cookie = csrfResponse.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return fetch(`http://127.0.0.1:${webPort}/auth/login`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ email, password }),
  });
}

let failure;
try {
  const first = startServer();
  try {
    await first.ready;
    assert(first.output().includes('Demo data seeded.'), 'first start seeds the demo data');
    assert(existsSync(join(temp, 'data', 'seeded')), 'seeded marker written');
    const page = await fetch(`http://127.0.0.1:${webPort}/some/spa/route`);
    assert(page.status === 200 && (await page.text()).includes('smoke'), 'web port serves SPA');
    const apiDirect = await fetch(`http://127.0.0.1:${apiPort}/auth/csrf`, {
      headers: { Origin: origin },
    });
    assert(apiDirect.status === 200, 'API port answers directly');
    const ok = await login('demo.student@example.test', 'Demo exam password 2026!');
    assert(ok.status === 200, 'demo student login works through the web-port proxy');
    const bad = await login('demo.student@example.test', 'wrong password');
    assert(bad.status >= 400 && bad.status < 500, 'wrong password is rejected');
  } finally {
    await first.stop();
  }

  const second = startServer();
  try {
    await second.ready;
    assert(second.output().includes('already seeded'), 'second start does not re-seed');
    assert(!second.output().includes('Wiping'), 'second start did not run the seed wipe');
    const ok = await login('demo.student@example.test', 'Demo exam password 2026!');
    assert(ok.status === 200, 'demo login still works after restart');
  } finally {
    await second.stop();
  }
  console.log('Bundle smoke test passed.');
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.message : error);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exit(failure === undefined ? 0 : 1);
