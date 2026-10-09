import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildServerEnv,
  CappedLog,
  resolveRuntimePaths,
  startRuntime,
  type RuntimeDeps,
  type ServerProcess,
} from './runtime';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  messages: unknown[] = [];
  killed = false;
  postMessage = (message: unknown): void => {
    this.messages.push(message);
    if (message === 'shutdown') this.finish(0);
  };
  kill = (): boolean => {
    this.killed = true;
    this.finish(null);
    return true;
  };
  finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
}

let userData: string;
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'eac-runtime-'));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<RuntimeDeps> = {}) {
  const process = new FakeProcess();
  const forkUtility = vi.fn((_entry: string, _options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    return process as unknown as ServerProcess;
  });
  const showError = vi.fn();
  const deps: RuntimeDeps = {
    isPackaged: true,
    resourcesPath: '/Applications/App.app/Contents/Resources',
    repoRoot: '/repo',
    userDataPath: userData,
    forkUtility,
    isPortFree: () => Promise.resolve(true),
    canConnect: () => Promise.resolve(true),
    showError,
    log: vi.fn(),
    sleep: () => Promise.resolve(),
    readyTimeoutMs: 2000,
    ...overrides,
  };
  return { deps, process, forkUtility, showError };
}

describe('runtime paths and environment', () => {
  it('points into resources when packaged and into the repo in development', () => {
    expect(
      resolveRuntimePaths({ isPackaged: true, resourcesPath: '/res', repoRoot: '/repo' }),
    ).toMatchObject({
      entry: '/res/api/api-server.mjs',
      webRoot: '/res/web',
      whisperBin: '/res/whisper/whisper-cli',
      whisperModel: '/res/whisper/ggml-base-q5_1.bin',
      ffmpegBin: undefined,
    });
    expect(
      resolveRuntimePaths({ isPackaged: false, resourcesPath: '/res', repoRoot: '/repo' }),
    ).toMatchObject({
      entry: '/repo/apps/api/dist/api-server.mjs',
      webRoot: '/repo/apps/web/dist',
      ffmpegBin: undefined,
    });
  });

  it('builds the server environment without NODE_ENV', () => {
    const env = buildServerEnv(
      { isPackaged: true, resourcesPath: '/res', repoRoot: '/repo', userDataPath: '/ud' },
      { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
    );
    expect(env).toMatchObject({
      KEEP: 'yes',
      API_PORT: '3000',
      WEB_PORT: '5173',
      DATABASE_PATH: '/ud/data/exam-anti-cheat.sqlite',
      SERVE_WEB_DIST: '/res/web',
      WHISPER_BIN: '/res/whisper/whisper-cli',
      WHISPER_MODEL_PATH: '/res/whisper/ggml-base-q5_1.bin',
    });
    expect(env.FFMPEG_BIN).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('uses a bundled ffmpeg only when it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eac-res-'));
    try {
      mkdirSync(join(dir, 'ffmpeg'));
      writeFileSync(join(dir, 'ffmpeg', 'ffmpeg'), '');
      const deps = { isPackaged: true, resourcesPath: dir, repoRoot: '/repo', userDataPath: '/ud' };
      expect(buildServerEnv(deps, {}).FFMPEG_BIN).toBe(join(dir, 'ffmpeg', 'ffmpeg'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the seed flag only for the judge build and never inherits it', () => {
    const paths = {
      isPackaged: true,
      resourcesPath: '/res',
      repoRoot: '/repo',
      userDataPath: '/ud',
    };
    expect(buildServerEnv({ ...paths, judgeBuild: true }, {}).EAC_SEED_DEMO).toBe('1');
    expect(buildServerEnv(paths, { EAC_SEED_DEMO: '1' }).EAC_SEED_DEMO).toBeUndefined();
    expect(
      buildServerEnv({ ...paths, judgeBuild: false }, { EAC_SEED_DEMO: '1' }).EAC_SEED_DEMO,
    ).toBeUndefined();
  });
});

describe('startRuntime', () => {
  it('forks the bundle with cwd=userData and waits for both ports', async () => {
    const { deps, forkUtility } = makeDeps();
    let polls = 0;
    const canConnect = vi.fn((port: number) => {
      polls += 1;
      return Promise.resolve(polls > 6 && (port === 3000 || port === 5173));
    });
    const handle = await startRuntime({ ...deps, canConnect });

    expect(handle).not.toBeNull();
    expect(forkUtility).toHaveBeenCalledTimes(1);
    const [entry, options] = forkUtility.mock.calls[0] ?? [];
    expect(entry).toBe('/Applications/App.app/Contents/Resources/api/api-server.mjs');
    expect(options?.cwd).toBe(userData);
    expect(options?.env.DATABASE_PATH).toBe(join(userData, 'data', 'exam-anti-cheat.sqlite'));
    expect(options?.env.NODE_ENV).toBeUndefined();
    expect(polls).toBeGreaterThan(6); // it kept polling until both ports answered
  });

  it('does not report ready while only one port answers', async () => {
    const { deps } = makeDeps({ readyTimeoutMs: 30, pollIntervalMs: 1, sleep: undefined });
    const result = await startRuntime({
      ...deps,
      canConnect: (port) => Promise.resolve(port === 3000),
    });
    expect(result).toBeNull();
  });

  it('shows a dialog naming a busy port and never starts the server', async () => {
    const { deps, forkUtility, showError } = makeDeps({
      isPortFree: (port) => Promise.resolve(port !== 5173),
    });
    const result = await startRuntime(deps);

    expect(result).toBeNull();
    expect(forkUtility).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(String(showError.mock.calls[0]?.[0])).toContain('5173');
    expect(String(showError.mock.calls[0]?.[1])).toContain('5173');
  });

  it('retries with plain Node mode when the utility process exits early', async () => {
    const utility = new FakeProcess();
    const node = new FakeProcess();
    const forkNode = vi.fn(() => node as unknown as ServerProcess);
    const { deps } = makeDeps({
      forkUtility: () => {
        queueMicrotask(() => utility.finish(1));
        return utility as unknown as ServerProcess;
      },
      forkNode,
      canConnect: () =>
        Promise.resolve(node.stdout !== undefined && forkNode.mock.calls.length > 0),
    });
    const handle = await startRuntime(deps);

    expect(forkNode).toHaveBeenCalledTimes(1);
    expect(handle).not.toBeNull();
  });

  it('reports a crash with the log location', async () => {
    const dead = new FakeProcess();
    const { deps, showError } = makeDeps({
      forkUtility: () => {
        queueMicrotask(() => dead.finish(1));
        return dead as unknown as ServerProcess;
      },
      canConnect: () => Promise.resolve(false),
    });
    expect(await startRuntime(deps)).toBeNull();
    expect(String(showError.mock.calls[0]?.[1])).toContain(join(userData, 'logs', 'api.log'));
  });

  it('asks the server to shut down on stop and falls back to kill', async () => {
    const { deps, process } = makeDeps({ canConnect: () => Promise.resolve(true) });
    const handle = await startRuntime(deps);
    await handle?.stop();
    expect(process.messages).toEqual(['shutdown']);
    expect(process.exited).toBe(true);
    expect(process.killed).toBe(false);

    vi.useFakeTimers();
    try {
      const stubborn = makeDeps({ canConnect: () => Promise.resolve(true) });
      stubborn.process.postMessage = (message: unknown) => {
        stubborn.process.messages.push(message);
      };
      const stubbornHandle = await startRuntime(stubborn.deps);
      const stopped = stubbornHandle?.stop();
      await vi.advanceTimersByTimeAsync(3500);
      await stopped;
      expect(stubborn.process.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes server output to logs/api.log', async () => {
    const { deps, process } = makeDeps({ canConnect: () => Promise.resolve(true) });
    await startRuntime(deps);
    process.stdout.emit('data', Buffer.from('hello from server\n'));
    expect(readFileSync(join(userData, 'logs', 'api.log'), 'utf8')).toContain('hello from server');
  });
});

describe('CappedLog', () => {
  it('rotates the file once it grows past the cap', () => {
    const file = join(userData, 'logs', 'api.log');
    const log = new CappedLog(file, 100);
    log.write('a'.repeat(80));
    log.write('b'.repeat(80));
    expect(readFileSync(file, 'utf8')).toBe('b'.repeat(80));
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('a'.repeat(80));
    writeFileSync(file, 'x');
  });
});
