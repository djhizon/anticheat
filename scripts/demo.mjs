/* global AbortSignal, clearInterval, console, fetch, process, setInterval, setTimeout */
// One-command local demo: `npm run demo` (or `npm run doctor` for checks only).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  backupName,
  buildEnvLocal,
  demoAccounts,
  formatTable,
  isPortInUse,
  minimumFromRange,
  openCommand,
  parseArgs,
  parseYesNo,
  planSteps,
  seedDefaults,
  shouldOpenBrowser,
  versionAtLeast,
} from './demo-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const webUrl = 'http://127.0.0.1:5173';

if (args.help || args.unknown.length) {
  if (args.unknown.length) console.error(`Unknown option(s): ${args.unknown.join(' ')}\n`);
  console.log(
    'Usage: npm run demo -- [--reset] [--share] [--no-open] [--yes]\n       npm run doctor\n\n' +
      '  --doctor   check prerequisites only\n' +
      '  --reset    move the existing demo database to a timestamped backup and re-seed\n' +
      '  --share    start via the ngrok share script (needs SHARE_HOST + ngrok)\n' +
      '  --no-open  do not open a browser\n' +
      '  --yes      answer yes to the optional Whisper build prompt',
  );
  process.exit(args.unknown.length ? 1 : 0);
}

const log = (message = '') => console.log(message);
const step = (message) => log(`\n▶ ${message}`);
const has = (command, versionArgs = ['--version']) =>
  spawnSync(command, versionArgs, { stdio: 'ignore' }).status === 0;

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    log(
      `\n❌ "${[command, ...commandArgs].join(' ')}" failed (exit ${result.status ?? 'signal'}).`,
    );
    process.exit(result.status ?? 1);
  }
}

function envLocalValue(name) {
  if (!existsSync('.env.local')) return undefined;
  const match = new RegExp(`^${name}=(.*)$`, 'mu').exec(readFileSync('.env.local', 'utf8'));
  return match?.[1]?.trim() || undefined;
}

function dbPath() {
  // The API runs from apps/api, so a relative DATABASE_PATH resolves there.
  const configured = process.env.DATABASE_PATH || envLocalValue('DATABASE_PATH');
  return resolve('apps/api', configured || './data/exam-anti-cheat.sqlite');
}

const whisperBinary = resolve('apps/api/vendor/whisper.cpp/build/bin/whisper-cli');
const whisperModel = resolve('apps/api/vendor/whisper.cpp/models/ggml-base.bin');

async function doctor() {
  const rows = [];
  const minNode = minimumFromRange(pkg.engines?.node) ?? '24.7.0';
  const minNpm = minimumFromRange(pkg.engines?.npm) ?? '10.0.0';
  const nodeOk = versionAtLeast(process.versions.node, minNode);
  rows.push({
    status: nodeOk ? 'ready' : 'required',
    name: `Node ${process.versions.node}`,
    detail: nodeOk
      ? `>= ${minNode}`
      : `need >= ${minNode}. Fix: nvm install 24 && nvm use 24  (or: brew install node@24)`,
  });
  const npmVersion = spawnSync(npm, ['--version'], { encoding: 'utf8' }).stdout?.trim();
  const npmOk = Boolean(npmVersion) && versionAtLeast(npmVersion, minNpm);
  rows.push({
    status: npmOk ? 'ready' : 'required',
    name: `npm ${npmVersion || '(not found)'}`,
    detail: npmOk ? `>= ${minNpm}` : `need >= ${minNpm}. Fix: npm install -g npm@latest`,
  });
  for (const port of [3000, 5173]) {
    const busy = await isPortInUse(port);
    rows.push({
      status: busy ? 'required' : 'ready',
      name: `Port ${port}`,
      detail: busy
        ? process.platform === 'win32'
          ? `in use. Fix: netstat -ano | findstr :${port}, then stop that process`
          : `in use. Fix: lsof -nP -iTCP:${port} -sTCP:LISTEN  then  kill <pid>`
        : 'free',
    });
  }
  const optional = [
    [
      'ffmpeg',
      ['-version'],
      'audio transcription disabled',
      'brew install ffmpeg  |  sudo apt install ffmpeg',
    ],
    [
      'cmake',
      ['--version'],
      'cannot build Whisper (transcription disabled)',
      'brew install cmake  |  sudo apt install cmake',
    ],
    [
      'git',
      ['--version'],
      'cannot build Whisper (transcription disabled)',
      'brew install git  |  sudo apt install git',
    ],
    [
      'python3',
      ['--version'],
      'server-side object detection disabled',
      'brew install python@3.12  |  sudo apt install python3 python3-venv',
    ],
  ];
  for (const [command, versionArgs, effect, fix] of optional) {
    const ok = has(command, versionArgs);
    rows.push({
      status: ok ? 'ready' : 'optional',
      name: command,
      detail: ok ? 'found' : `missing, ${effect}. Fix: ${fix}`,
    });
  }
  const whisperReady = existsSync(whisperBinary) && existsSync(whisperModel);
  rows.push({
    status: whisperReady ? 'ready' : 'optional',
    name: 'Whisper build',
    detail: whisperReady
      ? 'binary + model present'
      : 'not built, transcription disabled. Fix: npm run setup:whisper',
  });
  log('\nEnvironment check\n');
  log(formatTable(rows));
  return rows.every((row) => row.status !== 'required');
}

async function ask(question) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return parseYesNo(await rl.question(question));
  } finally {
    rl.close();
  }
}

function prepareConfig() {
  if (existsSync('.env.local')) {
    log('.env.local already exists, leaving it untouched.');
    return;
  }
  writeFileSync('.env.local', buildEnvLocal(readFileSync('.env.example', 'utf8')), {
    mode: 0o600,
  });
  log('Created .env.local from .env.example (credentials left blank).');
  log('  Everything below is OPTIONAL; the demo works offline without any of it:');
  log('  - GEMINI_API_KEYS      turns on AI exam generation and AI-written-answer checks');
  log('  - SUPABASE_*           turns on email sign-up, password reset and email change');
  log('  - Microsoft sign-in    needs Supabase configured first (Azure provider in its dashboard)');
  log('  - SHARE_HOST           ngrok domain for `npm run demo -- --share`');
}

/** Spawn the launcher and make sure SIGINT/SIGTERM take every child down. */
function supervise(script) {
  const child = spawn(process.execPath, [script], {
    stdio: 'inherit',
    // Own process group on POSIX so we can signal the whole tree (npm -> vite-node/vite).
    detached: process.platform !== 'win32',
  });
  let stopping = false;
  const killTree = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  const stop = (signal) => {
    if (stopping) {
      killTree('SIGKILL');
      return;
    }
    stopping = true;
    log('\nStopping demo servers...');
    killTree(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    setTimeout(() => killTree('SIGKILL'), 8000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('exit', () => killTree('SIGKILL'));
  child.on('exit', (code) => {
    log('Demo stopped.');
    process.exit(stopping ? 0 : (code ?? 1));
  });
  return child;
}

async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function waitForServers(onReady) {
  const started = Date.now();
  const timer = setInterval(async () => {
    if ((await answers('http://127.0.0.1:3000/')) && (await answers(`${webUrl}/`))) {
      clearInterval(timer);
      onReady();
    } else if (Date.now() - started > 180_000) {
      clearInterval(timer);
      log('\n⚠️  Servers did not answer within 3 minutes; check the output above.');
    }
  }, 1000);
}

function banner(url) {
  const defaults = seedDefaults(readFileSync('apps/api/src/seed-demo.ts', 'utf8'));
  const accounts = demoAccounts(defaults, process.env);
  const w = Math.max(...accounts.map((a) => a.email.length));
  const r = Math.max(...accounts.map((a) => a.role.length));
  log(
    [
      '',
      '════════════════════════════════════════════════════════════',
      `  Demo is running:  ${url}`,
      '',
      ...accounts.map((a) => `  ${a.role.padEnd(r)}  ${a.email.padEnd(w)}  ${a.password}`),
      '',
      '  Press Ctrl+C to stop.',
      '════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

function openBrowser(url) {
  const command = openCommand(process.platform);
  if (!command || !shouldOpenBrowser({ noOpen: args.noOpen, isTTY: process.stdout.isTTY })) return;
  spawn(command, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

async function main() {
  step('Doctor');
  const healthy = await doctor();
  if (args.doctor) {
    log(healthy ? '\nAll required checks passed.' : '\nFix the ❌ items above, then run again.');
    process.exit(healthy ? 0 : 1);
  }
  if (!healthy) {
    log('\nFix the ❌ items above, then run `npm run demo` again.');
    process.exit(1);
  }

  const database = dbPath();
  const marker = 'node_modules/.package-lock.json';
  const plan = planSteps({
    nodeModulesExists: existsSync('node_modules'),
    installMarkerMtimeMs: existsSync(marker) ? statSync(marker).mtimeMs : null,
    lockMtimeMs: statSync('package-lock.json').mtimeMs,
    visionExists: existsSync('apps/web/public/vision'),
    whisperBinary: existsSync(whisperBinary),
    whisperModel: existsSync(whisperModel),
    hasCmake: has('cmake'),
    hasGit: has('git'),
    envLocalExists: existsSync('.env.local'),
    dbExists: existsSync(database),
    reset: args.reset,
  });

  step('Dependencies');
  if (plan.install) run(npm, ['ci', '--no-audit', '--no-fund']);
  else log('node_modules is up to date.');

  step('Assets');
  run(npm, ['run', plan.visionAction === 'verify' ? 'vision:verify' : 'vision:prepare']);
  if (plan.askWhisper) {
    const build = await ask(
      'Speech transcription needs whisper.cpp. Build it now (about 2-5 minutes)? [y/N] ',
    );
    if (build) run(npm, ['run', 'setup:whisper']);
    else log('Skipping Whisper: transcription stays disabled. Enable later: npm run setup:whisper');
  } else if (plan.whisperDisabled) {
    log('Whisper not built and cmake/git missing: transcription disabled.');
  }

  step('Configuration');
  prepareConfig();
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');

  step('Demo data');
  if (plan.backupDb) {
    const backup = backupName(database);
    renameSync(database, backup);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(database + suffix)) renameSync(database + suffix, backup + suffix);
    }
    log(`Moved old database to ${backup}`);
  }
  if (plan.seed) run(npm, ['run', 'demo:seed']);
  else log('Demo database already exists (use --reset to start fresh).');

  step(args.share ? 'Starting (shared via ngrok)' : 'Starting servers');
  const shareHost = process.env.SHARE_HOST?.trim();
  const url = args.share && shareHost ? `https://${shareHost}` : webUrl;
  supervise(args.share ? 'scripts/share.mjs' : 'scripts/dev.mjs');
  waitForServers(() => {
    banner(url);
    openBrowser(url);
  });
}

await main();
