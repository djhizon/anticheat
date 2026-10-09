import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  backupName,
  buildEnvLocal,
  demoAccounts,
  formatTable,
  isPortInUse,
  minimumFromRange,
  needsInstall,
  parseArgs,
  parseVersion,
  parseYesNo,
  planSteps,
  seedDefaults,
  shouldOpenBrowser,
  versionAtLeast,
} from './demo-lib.mjs';

const base = {
  nodeModulesExists: true,
  installMarkerMtimeMs: 200,
  lockMtimeMs: 100,
  visionExists: true,
  whisperBinary: true,
  whisperModel: true,
  hasCmake: true,
  hasGit: true,
  envLocalExists: true,
  dbExists: true,
  reset: false,
};

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v24.7.1')).toEqual([24, 7, 1]);
    expect(parseVersion('nope')).toBeNull();
    expect(minimumFromRange('>=24.7.0')).toBe('24.7.0');
    expect(versionAtLeast('24.7.0', '24.7.0')).toBe(true);
    expect(versionAtLeast('24.6.9', '24.7.0')).toBe(false);
    expect(versionAtLeast('25.0.0', '24.7.0')).toBe(true);
    expect(versionAtLeast('22.1.0', '24.7.0')).toBe(false);
    expect(versionAtLeast('garbage', '24.7.0')).toBe(false);
  });
});

describe('args', () => {
  it('parses flags and reports unknown ones', () => {
    expect(parseArgs(['--reset', '--no-open'])).toMatchObject({ reset: true, noOpen: true });
    expect(parseArgs(['--bogus']).unknown).toEqual(['--bogus']);
  });
});

describe('isPortInUse', () => {
  it('detects a listening port and a free one', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(await isPortInUse(port, ['127.0.0.1'])).toBe(true);
    await new Promise((done) => server.close(done));
    expect(await isPortInUse(port, ['127.0.0.1'])).toBe(false);
  });
});

describe('planSteps', () => {
  it('does nothing extra when everything exists', () => {
    expect(planSteps(base)).toMatchObject({
      install: false,
      visionAction: 'verify',
      askWhisper: false,
      whisperDisabled: false,
      createEnv: false,
      seed: false,
      backupDb: false,
    });
  });
  it('installs when missing or lockfile is newer', () => {
    expect(needsInstall({ ...base, nodeModulesExists: false })).toBe(true);
    expect(needsInstall({ ...base, lockMtimeMs: 300 })).toBe(true);
    expect(needsInstall(base)).toBe(false);
  });
  it('prepares vision, asks about whisper only when buildable', () => {
    const missing = { ...base, visionExists: false, whisperBinary: false };
    expect(planSteps(missing)).toMatchObject({ visionAction: 'prepare', askWhisper: true });
    expect(planSteps({ ...missing, hasCmake: false })).toMatchObject({
      askWhisper: false,
      whisperDisabled: true,
    });
  });
  it('seeds when DB is absent and backs up on reset', () => {
    expect(planSteps({ ...base, dbExists: false })).toMatchObject({ seed: true, backupDb: false });
    expect(planSteps({ ...base, reset: true })).toMatchObject({ seed: true, backupDb: true });
  });
});

describe('prompts and naming', () => {
  it('defaults to no', () => {
    expect(parseYesNo('')).toBe(false);
    expect(parseYesNo('n')).toBe(false);
    expect(parseYesNo(' Y ')).toBe(true);
    expect(parseYesNo('yes')).toBe(true);
  });
  it('builds a timestamped backup name', () => {
    expect(backupName('/x/db.sqlite', new Date('2026-01-02T03:04:05.678Z'))).toBe(
      '/x/db.sqlite.backup-2026-01-02T03-04-05-678Z',
    );
  });
  it('opens the browser only on a TTY without --no-open', () => {
    expect(shouldOpenBrowser({ noOpen: false, isTTY: true })).toBe(true);
    expect(shouldOpenBrowser({ noOpen: true, isTTY: true })).toBe(false);
    expect(shouldOpenBrowser({ noOpen: false, isTTY: false })).toBe(false);
  });
});

describe('env and accounts', () => {
  it('blanks credentials but keeps safe defaults', () => {
    const out = buildEnvLocal(
      'PORT=3000\nGEMINI_API_KEYS=your-key-1\nSUPABASE_URL=https://<ref>.supabase.co\n# c\nSITE_URL=http://localhost:5173',
    );
    expect(out).toBe(
      'PORT=3000\nGEMINI_API_KEYS=\nSUPABASE_URL=\n# c\nSITE_URL=http://localhost:5173',
    );
  });
  it('reads seed defaults and applies env overrides', () => {
    const defaults = seedDefaults("const a = process.env.DEMO_STUDENT_EMAIL ?? 'a@b.test';");
    expect(defaults.studentEmail).toBe('a@b.test');
    const accounts = demoAccounts(defaults, { DEMO_INSTRUCTOR_PASSWORD: 'pw' });
    expect(accounts).toHaveLength(6);
    expect(accounts[1]?.password).toBe('pw');
    expect(accounts[2]?.email).toBe('classmate1@example.test');
  });
  it('formats the doctor table', () => {
    const table = formatTable([
      { status: 'ready', name: 'Node', detail: 'ok' },
      { status: 'required', name: 'Port 3000', detail: 'busy' },
    ]);
    expect(table.split('\n')[0]).toContain('✅ Node       ok');
    expect(table).toContain('❌ Port 3000  busy');
  });
});
