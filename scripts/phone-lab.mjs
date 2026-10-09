/* global console, process, fetch, setTimeout, URL, Buffer */
// Phone lab: one command to test the real iPhone presence app against this laptop.
// Starts an isolated API (:3600) and web server (:5773) on the LAN, seeds demo data, starts the
// demo student's exam attempt, prints a pairing QR for the iPhone, then watches the attempt's
// integrity timeline (paired, lost, reconnected, left the app) and the laptop's evidence
// snapshots live as an instructor. `--auto` plays the phone's part instead. Trusted Wi-Fi only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';

import { runAuto } from './phone-lab-auto.mjs';
import {
  createDeduper,
  evidenceFileName,
  evidenceItems,
  evidenceKey,
  formatEvidence,
  formatTimelineEntry,
  paint,
  pairingLink,
  pickLanIp,
  qrMatrixFromSvg,
  renderQr,
} from './phone-lab-lib.mjs';

const apiPort = process.env.LAB_API_PORT ?? '3600';
const webPort = process.env.LAB_WEB_PORT ?? '5773';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const say = (text = '') => console.log(text);
const tag = (text, name) => paint(text, name, colour);

if (process.env.NODE_ENV === 'production') {
  console.error('The phone lab is a development tool and must not run in production.');
  process.exit(1);
}
const lanIp = pickLanIp(networkInterfaces());
if (!lanIp) {
  console.error('No private Wi-Fi IPv4 address found (en0/en1). Connect to Wi-Fi first.');
  process.exit(1);
}

const student = { email: 'demo.student@example.test', password: 'Demo exam password 2026!' };
const instructor = {
  email: 'demo.instructor@example.test',
  password: 'Demo instructor password 2026!',
};
const lanOrigin = `http://${lanIp}:${webPort}`;
const localOrigin = `http://localhost:${webPort}`;
const apiBase = `http://127.0.0.1:${apiPort}`;

const labDir = join(tmpdir(), 'exam-phone-lab');
mkdirSync(labDir, { recursive: true });
const databasePath = join(labDir, `lab-${apiPort}.sqlite`);
for (const suffix of ['', '-wal', '-shm', '-journal'])
  rmSync(databasePath + suffix, { force: true });

const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '0.0.0.0',
  PORT: apiPort,
  DATABASE_PATH: databasePath,
  ALLOWED_ORIGINS: [lanOrigin, localOrigin, `http://127.0.0.1:${webPort}`].join(','),
  // Cloud features stay off: empty shell values win over any .env.local.
  GEMINI_API_KEYS: '',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ENABLE_BACKEND_VISION: 'false',
  SERVE_WEB_DIST: '',
  DEMO_STUDENT_EMAIL: student.email,
  DEMO_STUDENT_PASSWORD: student.password,
  DEMO_INSTRUCTOR_EMAIL: instructor.email,
  DEMO_INSTRUCTOR_PASSWORD: instructor.password,
  LAB_API_PORT: apiPort,
  LAB_WEB_PORT: webPort,
};
const auto = process.argv.includes('--auto');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// In a worktree node_modules lives above the repo root; vite-node would refuse to inline
// dependencies from outside its root, so point it at the directory that holds node_modules.
function modulesRoot() {
  let dir = root;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'vite-node'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return root;
    dir = parent;
  }
}
const outsideRoot = modulesRoot() !== root;
/** [command, args, options] that run an API entry (seed or server), via vite-node --root in a worktree. */
function apiEntry(file, npmScript) {
  if (!outsideRoot)
    return [npm, ['run', npmScript, '--workspace', '@examguard/api'], { cwd: root }];
  const bin = join(modulesRoot(), 'node_modules', '.bin', 'vite-node');
  return [bin, ['--root', modulesRoot(), file], { cwd: join(root, 'apps/api') }];
}

// ── Children and clean shutdown ──────────────────────────────────────────────────────────
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  say(`\n${tag('Stopping phone lab…', 'dim')}`);
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const force = setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(code);
  }, 5000);
  force.unref();
  Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((done) => child.once('exit', done)),
    ),
  ).then(() => process.exit(code));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

function launch(name, command, args, options) {
  const child = spawn(command, args, { env, stdio: 'inherit', detached: true, ...options });
  children.push(child);
  child.once('exit', (exitCode, signal) => {
    if (!stopping) {
      console.error(`${name} stopped unexpectedly (${signal ?? `exit code ${exitCode}`}).`);
      stop(1);
    }
  });
  return child;
}

async function waitFor(url, label) {
  for (let i = 0; i < 120; i += 1) {
    if (stopping) return;
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} did not start within 60 s.`);
}

// ── API client with its own cookie jar ───────────────────────────────────────────────────
class Client {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
    this.csrf = undefined;
  }
  async call(method, path, body, { binary = false } = {}) {
    const headers = {
      accept: 'application/json',
      origin: localOrigin,
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    if (path === '/auth/csrf') headers['x-requested-with'] = 'examguard-browser';
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value) this.jar.set(name, decodeURIComponent(value));
      else this.jar.delete(name);
    }
    if (binary) return { status: response.status, data: Buffer.from(await response.arrayBuffer()) };
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }
  async login(account) {
    const csrf = await this.call('GET', '/auth/csrf');
    this.csrf = csrf.data?.csrfToken;
    const result = await this.call('POST', '/auth/login', account);
    if (result.status !== 200) {
      throw new Error(`${this.label} login failed (HTTP ${result.status}).`);
    }
    this.csrf = result.data?.csrfToken ?? this.csrf;
  }
  async ok(method, path, body) {
    const result = await this.call(method, path, body);
    if (result.status >= 400) throw new Error(`${method} ${path} failed (HTTP ${result.status}).`);
    return result.data;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────
async function printPairing(studentClient, attemptId) {
  const pairing = await studentClient.ok('POST', `/exam/attempts/${attemptId}/phone-presence`);
  const link = pairingLink(lanOrigin, pairing.code);
  const svg = renderToStaticMarkup(
    createElement(QRCodeSVG, { value: link, marginSize: 0, level: 'L' }),
  );
  say('');
  say(tag('Scan this with the iPhone Camera app (opens Exam Companion):', 'cyan'));
  say(renderQr(qrMatrixFromSvg(svg)));
  say('');
  say(`Pairing link (private): ${link}`);
  say(`Expires at ${new Date(pairing.expiresAt).toLocaleTimeString()} (2 minutes).`);
  if (process.stdin.isTTY && !auto) say(tag('Press r for a new QR, Ctrl+C to stop.', 'dim'));
  return pairing.code;
}

async function main() {
  say(tag('Phone lab', 'cyan') + `  LAN ${lanIp}  API :${apiPort}  web :${webPort}`);
  const visionDir = join(root, 'apps/web/public/vision');
  if (!existsSync(visionDir)) {
    say('Preparing on-device vision assets (first run only)…');
    const prepared = spawnSync(npm, ['run', 'vision:prepare'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    if (prepared.status !== 0)
      console.warn('vision:prepare failed; the laptop camera checks may not load.');
  }
  say('Seeding demo data…');
  const [seedCmd, seedArgs, seedOpts] = apiEntry('src/seed-demo.ts', 'demo:seed');
  const seed = spawnSync(seedCmd, seedArgs, { ...seedOpts, env, stdio: 'inherit' });
  if (seed.status !== 0) throw new Error('Demo seed failed.');

  const [apiCmd, apiArgs, apiOpts] = apiEntry('src/start.ts', 'dev');
  launch('API', apiCmd, apiArgs, apiOpts);
  const viteBin = join(modulesRoot(), 'node_modules', 'vite', 'bin', 'vite.js');
  launch(
    'Web server',
    process.execPath,
    [viteBin, '--config', join(root, 'scripts/phone-lab.vite.config.ts'), '--host', '0.0.0.0'],
    { cwd: join(root, 'apps/web') },
  );
  await waitFor(`${apiBase}/auth/csrf`, 'API');
  await waitFor(`http://127.0.0.1:${webPort}/`, 'Web server');
  if (stopping) return;

  const studentClient = new Client('Student');
  await studentClient.login(student);
  const assignments = (await studentClient.ok('GET', '/exam/assignments')).assignments;
  const assignment =
    assignments.find((a) => a.attemptStatus === 'in_progress') ??
    assignments.find((a) => a.attemptStatus === null);
  if (!assignment) throw new Error('The demo student has no exam available to start.');
  const delivery = await studentClient.ok('POST', `/exam/assignments/${assignment.id}/start`);
  const attemptId = (delivery.delivery ?? delivery).attempt.id;
  say(`\nExam "${assignment.title}" started. Attempt ${attemptId}`);

  const pairingCode = await printPairing(studentClient, attemptId);
  say('');
  say(tag('Open on this Mac (Chrome):', 'cyan') + `  ${localOrigin}/`);
  say(`  student:    ${student.email} / ${student.password}`);
  say(`  instructor: ${instructor.email} / ${instructor.password}`);
  say('  Signing in as the student resumes this same attempt. Using Require iPhone in the');
  say('  browser replaces the pairing above (only the latest pairing works).');
  say('');
  say(tag('Live monitor (every 2 s). Timeline and evidence appear below.', 'cyan'));
  say('');

  if (process.stdin.isTTY && !auto) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      const text = key.toString();
      if (text === '\u0003') stop(0);
      else if (text.toLowerCase() === 'r')
        printPairing(studentClient, attemptId).catch((e) => console.error(e.message));
    });
  }

  const instructorClient = new Client('Instructor');
  await instructorClient.login(instructor);
  if (!auto) {
    await monitor(instructorClient, attemptId);
    return;
  }
  void monitor(instructorClient, attemptId);
  const failed = await runAuto({
    studentClient,
    instructorClient,
    attemptId,
    pairingCode,
    webPort,
    say,
    tag,
  });
  stop(failed ? 1 : 0);
}

async function monitor(client, attemptId) {
  const outDir = join(
    root,
    'lab-output',
    new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, ''),
  );
  const timeline = createDeduper();
  const evidence = createDeduper(evidenceKey);
  let lastError = '';
  let evidenceNoted = false;
  while (!stopping) {
    try {
      const tl = await client.call('GET', `/exam/attempts/${attemptId}/timeline`);
      if (tl.status === 200) {
        for (const entry of timeline.fresh(tl.data?.entries ?? []))
          say(formatTimelineEntry(entry, colour));
      } else if (tl.status === 401 || tl.status === 403) {
        await client.login(instructor);
      } else {
        throw new Error(`timeline HTTP ${tl.status}`);
      }
      const ev = await client.call('GET', `/exam/attempts/${attemptId}/evidence`);
      if (ev.status === 200) {
        for (const item of evidence.fresh(evidenceItems(ev.data))) {
          let saved = null;
          const image = await client.call(
            'GET',
            `/exam/attempts/${attemptId}/evidence/${encodeURIComponent(item.id)}`,
            undefined,
            { binary: true },
          );
          if (image.status === 200) {
            mkdirSync(outDir, { recursive: true });
            saved = join(outDir, evidenceFileName(item));
            writeFileSync(saved, image.data);
          }
          say(formatEvidence(item, saved, colour));
        }
      } else if (ev.status === 404 && !evidenceNoted) {
        evidenceNoted = true;
        say(tag('(evidence endpoint not available on this build; timeline only)', 'dim'));
      }
      lastError = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) console.error(tag(`monitor: ${message}`, 'red'));
      lastError = message;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
});
