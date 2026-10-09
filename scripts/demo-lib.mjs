// Pure(ish) helpers for scripts/demo.mjs. Kept separate so they can be unit-tested.
import { connect } from 'node:net';

/** Parse "v24.7.0" / "24.7" into [major, minor, patch]; null when unparseable. */
export function parseVersion(text) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(String(text ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** True when `actual` >= `minimum` (both version strings). */
export function versionAtLeast(actual, minimum) {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

/** Extract the minimum version from an engines range such as ">=24.7.0". */
export function minimumFromRange(range) {
  const match = /(\d+(?:\.\d+){0,2})/u.exec(String(range ?? ''));
  return match ? match[1] : null;
}

export function parseArgs(argv) {
  const flags = new Set(argv);
  const known = new Set(['--doctor', '--reset', '--share', '--no-open', '--yes', '--help']);
  const unknown = argv.filter((arg) => !known.has(arg));
  return {
    doctor: flags.has('--doctor'),
    reset: flags.has('--reset'),
    share: flags.has('--share'),
    noOpen: flags.has('--no-open'),
    yes: flags.has('--yes'),
    help: flags.has('--help'),
    unknown,
  };
}

/** True when something accepts TCP connections on host:port. */
export function isPortInUse(port, hosts = ['127.0.0.1', '::1']) {
  const attempt = (host) =>
    new Promise((resolveAttempt) => {
      const socket = connect({ port, host });
      const done = (value) => {
        socket.destroy();
        resolveAttempt(value);
      };
      socket.setTimeout(750, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return Promise.all(hosts.map(attempt)).then((results) => results.some(Boolean));
}

/** `npm ci` is needed when node_modules is missing or the lockfile is newer than the install. */
export function needsInstall({ nodeModulesExists, installMarkerMtimeMs, lockMtimeMs }) {
  if (!nodeModulesExists) return true;
  if (installMarkerMtimeMs == null) return false;
  return lockMtimeMs > installMarkerMtimeMs;
}

/** Decide the bootstrap steps from observed state. Pure so it can be tested. */
export function planSteps(state) {
  const whisperPresent = state.whisperBinary && state.whisperModel;
  const canBuildWhisper = state.hasCmake && state.hasGit;
  return {
    install: needsInstall(state),
    visionAction: state.visionExists ? 'verify' : 'prepare',
    askWhisper: !whisperPresent && canBuildWhisper,
    whisperDisabled: !whisperPresent && !canBuildWhisper,
    createEnv: !state.envLocalExists,
    seed: state.reset ? true : !state.dbExists,
    backupDb: Boolean(state.reset && state.dbExists),
  };
}

/** Interpret a y/N answer; empty or non-TTY defaults to no. */
export function parseYesNo(answer) {
  return /^\s*y(es)?\s*$/iu.test(String(answer ?? ''));
}

export function backupName(dbPath, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/gu, '-');
  return `${dbPath}.backup-${stamp}`;
}

/** Variables that must be blank in a generated .env.local (no invented keys/secrets). */
const BLANK_KEYS = new Set([
  'GEMINI_API_KEYS',
  'VISION_PYTHON',
  'LIVENESS_SECRET',
  'SHARE_HOST',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

/** Turn .env.example into a .env.local: safe local defaults kept, credentials blank. */
export function buildEnvLocal(example) {
  return example
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      return BLANK_KEYS.has(key) || value.includes('<') ? `${key}=` : line;
    })
    .join('\n');
}

const SEED_DEFAULTS = {
  studentEmail: 'demo.student@example.test',
  studentPassword: 'Demo exam password 2026!',
  instructorEmail: 'demo.instructor@example.test',
  instructorPassword: 'Demo instructor password 2026!',
  classmatePassword: 'Demo classmate password 2026!',
  classmateEmails: [1, 2, 3, 4].map((n) => `classmate${n}@example.test`),
};

/** Read the `process.env.X ?? 'default'` literals from seed-demo.ts; fall back to known values. */
export function seedDefaults(source = '') {
  const pick = (name, fallback) => {
    const match = new RegExp(`process\\.env\\.${name} \\?\\? '([^']*)'`, 'u').exec(source);
    return match ? match[1] : fallback;
  };
  return {
    studentEmail: pick('DEMO_STUDENT_EMAIL', SEED_DEFAULTS.studentEmail),
    studentPassword: pick('DEMO_STUDENT_PASSWORD', SEED_DEFAULTS.studentPassword),
    instructorEmail: pick('DEMO_INSTRUCTOR_EMAIL', SEED_DEFAULTS.instructorEmail),
    instructorPassword: pick('DEMO_INSTRUCTOR_PASSWORD', SEED_DEFAULTS.instructorPassword),
    classmatePassword: pick('DEMO_CLASSMATE_PASSWORD', SEED_DEFAULTS.classmatePassword),
    classmateEmails: SEED_DEFAULTS.classmateEmails,
  };
}

/** Accounts to print, with environment overrides applied. */
export function demoAccounts(defaults, env = {}) {
  const v = (name, fallback) => (env[name] && env[name].trim() ? env[name] : fallback);
  const classmatePassword = v('DEMO_CLASSMATE_PASSWORD', defaults.classmatePassword);
  return [
    {
      role: 'Student',
      email: v('DEMO_STUDENT_EMAIL', defaults.studentEmail),
      password: v('DEMO_STUDENT_PASSWORD', defaults.studentPassword),
    },
    {
      role: 'Instructor',
      email: v('DEMO_INSTRUCTOR_EMAIL', defaults.instructorEmail),
      password: v('DEMO_INSTRUCTOR_PASSWORD', defaults.instructorPassword),
    },
    ...defaults.classmateEmails.map((email, index) => ({
      role: `Classmate ${index + 1}`,
      email,
      password: classmatePassword,
    })),
  ];
}

export const STATUS = { ready: '✅', optional: '⚠️ ', required: '❌' };

/** Render rows of {status, name, detail} as an aligned table. */
export function formatTable(rows) {
  const width = Math.max(...rows.map((row) => row.name.length));
  return rows
    .map((row) => `${STATUS[row.status]} ${row.name.padEnd(width)}  ${row.detail}`)
    .join('\n');
}

/** Whether the browser should be opened automatically. */
export function shouldOpenBrowser({ noOpen, isTTY }) {
  return !noOpen && Boolean(isTTY);
}

export function openCommand(platform) {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

/** Parse xcodebuild -version output to extract version string. */
export function parseXcodeVersion(output) {
  const text = String(output ?? '');
  const match = /^Xcode\s+(\d+(?:\.\d+)*(?:\.\d+)*)/m.exec(text);
  return match ? match[1] : null;
}

/** Parse xcodegen --version output to extract version string. */
export function parseXcodegenVersion(output) {
  const text = String(output ?? '');
  const match = /(\d+(?:\.\d+)*(?:\.\d+)*)/u.exec(text);
  return match ? match[1] : null;
}

/** Parse xcrun devicectl list devices output to find connected iPhone name + model + state. */
export function parseDevicectlDevices(output) {
  const text = String(output ?? '').trim();
  if (!text || text.includes('No devices found') || !text.includes('Name')) return null;

  const lines = text.split(/\r?\n/u);
  const separatorIndex = lines.findIndex((line) => line.startsWith('---'));
  if (separatorIndex === -1) return null;

  const separator = lines[separatorIndex];
  const columns = [];
  let start = 0;
  for (let i = 0; i < separator.length; i += 1) {
    if (separator[i] === '-' && (i === 0 || separator[i - 1] === ' ')) {
      start = i;
    }
    if (separator[i] === '-' && (i === separator.length - 1 || separator[i + 1] === ' ')) {
      columns.push([start, i + 1]);
    }
  }
  if (columns.length < 5) return null;

  const [nameCol, , , stateCol, modelCol] = columns;
  const devices = [];
  for (let i = separatorIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const name = line.slice(nameCol[0], nameCol[1]).trim();
    const state = line.slice(stateCol[0], stateCol[1]).trim();
    const model = line.slice(modelCol[0]).trim();
    if (name && model) devices.push({ name, model, state });
  }

  const iphones = devices.filter((d) => d.model.toLowerCase().startsWith('iphone'));
  if (iphones.length === 0) return null;

  const readyStates = ['connected', 'available (paired)'];
  const readyDevice = iphones.find((d) => readyStates.includes(d.state.toLowerCase()));
  return readyDevice || iphones[0];
}
