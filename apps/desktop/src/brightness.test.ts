import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrightnessController,
  ENFORCE_INTERVAL_MS,
  RESTORE_LOG_INTERVAL_MS,
  type BrightnessHelper,
  type BrightnessReading,
  type OriginalStore,
  type TimerApi,
} from './brightness';
import { createOriginalStore, registerDisplayBrightness } from './displayBrightness';
import type { RunMode } from './mode';

/** A fake panel: the helper reads and writes `level`; `supported` models external-only setups. */
function fakeHelper(initial: number, supported = true, clampTo = 1) {
  const state = { level: initial, supported, calls: [] as string[], fail: false };
  const reading = (): BrightnessReading =>
    state.supported
      ? { supported: true, brightness: state.level }
      : { supported: false, brightness: null };
  const helper: BrightnessHelper = {
    async get() {
      state.calls.push('get');
      if (state.fail) throw new Error('helper down');
      return reading();
    },
    async set(level) {
      state.calls.push(`set:${level}`);
      if (state.fail) throw new Error('helper down');
      if (state.supported) state.level = Math.min(level, clampTo);
      return reading();
    },
  };
  return { helper, state };
}

function fakeStore(initial: number | null = null) {
  const state = { value: initial };
  const store: OriginalStore = {
    read: () => state.value,
    write: (level) => {
      state.value = level;
    },
    clear: () => {
      state.value = null;
    },
  };
  return { store, state };
}

function fakeTimers() {
  const handles = new Map<number, () => void>();
  let next = 1;
  const timers: TimerApi = {
    setInterval: (callback) => {
      handles.set(next, callback);
      return next++;
    },
    clearInterval: (handle) => {
      handles.delete(handle as number);
    },
  };
  /** Fire every live interval once and let queued helper work settle. */
  const tick = async () => {
    for (const callback of [...handles.values()]) callback();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return { timers, tick, count: () => handles.size };
}

function setup(options: { level?: number; mode?: RunMode; stored?: number | null } = {}) {
  const panel = fakeHelper(options.level ?? 0.4);
  const persisted = fakeStore(options.stored ?? null);
  const clock = fakeTimers();
  let mode: RunMode = options.mode ?? 'strict';
  let now = 1_000_000;
  const onRestored = vi.fn();
  const controller = createBrightnessController({
    helper: panel.helper,
    store: persisted.store,
    getMode: () => mode,
    onRestored,
    timers: clock.timers,
    now: () => now,
  });
  return {
    controller,
    panel,
    persisted,
    clock,
    onRestored,
    setMode: (value: RunMode) => (mode = value),
    advance: (ms: number) => (now += ms),
  };
}

describe('brightness enforcement state machine', () => {
  it('remembers the level, persists it, and sets 100% on boost', async () => {
    const t = setup({ level: 0.4 });
    expect(await t.controller.boost('attempt-1')).toEqual({ status: 'boosted', enforcing: true });
    expect(t.panel.state.level).toBe(1);
    expect(t.persisted.state.value).toBe(0.4);
    expect(t.controller.isActive()).toBe(true);
    expect(t.clock.count()).toBe(1);
  });

  it('does not overwrite the remembered level when boosted twice', async () => {
    const t = setup({ level: 0.4 });
    await t.controller.boost('a');
    await t.controller.boost('a');
    expect(t.persisted.state.value).toBe(0.4);
    await t.controller.restore();
    expect(t.panel.state.level).toBe(0.4);
  });

  it('Strict sets it back when the student lowers it and logs once per interval', async () => {
    const t = setup({ mode: 'strict' });
    await t.controller.boost('attempt-1');
    t.panel.state.level = 0.5;
    await t.clock.tick();
    expect(t.panel.state.level).toBe(1);
    expect(t.onRestored).toHaveBeenCalledTimes(1);
    expect(t.onRestored).toHaveBeenCalledWith('attempt-1');
    // Lowered again right away: still restored, but the log is rate-limited.
    t.panel.state.level = 0.2;
    t.advance(ENFORCE_INTERVAL_MS);
    await t.clock.tick();
    expect(t.panel.state.level).toBe(1);
    expect(t.onRestored).toHaveBeenCalledTimes(1);
    t.panel.state.level = 0.2;
    t.advance(RESTORE_LOG_INTERVAL_MS);
    await t.clock.tick();
    expect(t.onRestored).toHaveBeenCalledTimes(2);
  });

  it('Strict does nothing while the level is still at maximum', async () => {
    const t = setup({ mode: 'strict' });
    await t.controller.boost('a');
    t.panel.state.calls.length = 0;
    await t.clock.tick();
    expect(t.panel.state.calls).toEqual(['get']);
    expect(t.onRestored).not.toHaveBeenCalled();
  });

  it('Demo sets once and never fights the student', async () => {
    const t = setup({ mode: 'demo' });
    expect(await t.controller.boost('a')).toEqual({ status: 'boosted', enforcing: false });
    expect(t.panel.state.level).toBe(1);
    expect(t.clock.count()).toBe(0);
    t.panel.state.level = 0.3;
    await t.clock.tick();
    expect(t.panel.state.level).toBe(0.3);
    expect(t.onRestored).not.toHaveBeenCalled();
  });

  it('stops enforcing if the mode switches to Demo mid-exam', async () => {
    const t = setup({ mode: 'strict' });
    await t.controller.boost('a');
    t.setMode('demo');
    t.panel.state.level = 0.3;
    await t.clock.tick();
    expect(t.panel.state.level).toBe(0.3);
  });

  it('restores the original level on exit, clears the record and stops polling', async () => {
    const t = setup({ level: 0.35 });
    await t.controller.boost('a');
    await t.controller.restore();
    expect(t.panel.state.level).toBe(0.35);
    expect(t.persisted.state.value).toBeNull();
    expect(t.clock.count()).toBe(0);
    expect(t.controller.isActive()).toBe(false);
    t.panel.state.calls.length = 0;
    await t.controller.restore();
    expect(t.panel.state.calls).toEqual([]);
  });

  it('a restore requested during a boost waits and then undoes it', async () => {
    const t = setup({ level: 0.6 });
    const boosting = t.controller.boost('a');
    const restoring = t.controller.restore();
    await Promise.all([boosting, restoring]);
    expect(t.panel.state.level).toBe(0.6);
    expect(t.controller.isActive()).toBe(false);
  });

  it('reports unsupported when the helper cannot see a built-in display', async () => {
    const t = setup();
    t.panel.state.supported = false;
    expect(await t.controller.boost('a')).toEqual({ status: 'unsupported', enforcing: false });
    expect(t.persisted.state.value).toBeNull();
    expect(t.clock.count()).toBe(0);
    expect(t.controller.isActive()).toBe(false);
  });

  it('reports unsupported and reverts when the level will not reach maximum', async () => {
    const panel = fakeHelper(0.4, true, 0.6);
    const persisted = fakeStore();
    const controller = createBrightnessController({
      helper: panel.helper,
      store: persisted.store,
      getMode: () => 'strict',
      onRestored: vi.fn(),
      timers: fakeTimers().timers,
    });
    expect((await controller.boost('a')).status).toBe('unsupported');
    expect(panel.state.level).toBe(0.4);
    expect(persisted.state.value).toBeNull();
  });

  it('survives a throwing helper without leaving state behind', async () => {
    const t = setup();
    t.panel.state.fail = true;
    expect((await t.controller.boost('a')).status).toBe('unsupported');
    await expect(t.controller.restore()).resolves.toBeUndefined();
  });
});

describe('crash-safe restore on next launch', () => {
  it('puts the persisted level back and clears the record', async () => {
    const t = setup({ level: 1, stored: 0.45 });
    await t.controller.recover();
    expect(t.panel.state.level).toBe(0.45);
    expect(t.persisted.state.value).toBeNull();
  });

  it('does nothing when no level was left behind', async () => {
    const t = setup({ level: 0.8 });
    await t.controller.recover();
    expect(t.panel.state.calls).toEqual([]);
  });

  it('keeps the record when the helper is unavailable so a later launch can retry', async () => {
    const t = setup({ level: 1, stored: 0.45 });
    t.panel.state.supported = false;
    await t.controller.recover();
    expect(t.persisted.state.value).toBe(0.45);
  });

  it('does not recover over an active exam', async () => {
    const t = setup({ level: 0.4 });
    await t.controller.boost('a');
    await t.controller.recover();
    expect(t.panel.state.level).toBe(1);
  });
});

describe('persistence and IPC wiring', () => {
  it('stores and reads the original level in userData, rejecting junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brightness-'));
    try {
      const store = createOriginalStore(dir);
      expect(store.read()).toBeNull();
      store.write(0.42);
      expect(store.read()).toBe(0.42);
      store.clear();
      expect(store.read()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only serves a trusted app frame with a valid attempt id', async () => {
    const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
    const quitListeners: ((event: { preventDefault(): void }) => void)[] = [];
    let trusted = false;
    registerDisplayBrightness({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: (_event, listener) => quitListeners.push(listener),
        quit: vi.fn(),
        getPath: () => mkdtempSync(join(tmpdir(), 'brightness-')),
      },
      resourcesPath: '/nonexistent',
      appDir: '/nonexistent/dist',
      getMode: () => 'strict',
      trustedAppFrame: () => trusted,
      validAttemptId: (value): value is string => typeof value === 'string' && value.length > 0,
      notifyRestored: vi.fn(),
      log: vi.fn(),
    });
    const boost = handlers.get('display:boost-brightness')!;
    const restore = handlers.get('display:restore-brightness')!;
    expect(() => boost({} as never, 'attempt')).toThrow('Untrusted');
    await expect(restore({} as never)).rejects.toThrow('Untrusted');
    trusted = true;
    expect(() => boost({} as never, 42)).toThrow('Untrusted');
    // Trusted: the (missing) helper degrades to "unsupported", never an exception.
    expect(await boost({} as never, 'attempt')).toEqual({
      status: 'unsupported',
      enforcing: false,
    });
    expect(await restore({} as never)).toEqual({ status: 'restored' });
    // Nothing active, so quitting is not delayed.
    const preventDefault = vi.fn();
    quitListeners[0]!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
