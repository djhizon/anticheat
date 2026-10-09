import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLockdown,
  isBlockedShortcut,
  RESTORE_DEBOUNCE_MS,
  type LockdownBrowserWindow,
  type Rect,
} from './lockdownWindow';
import type { RunMode } from './mode';

const PRIMARY: Rect = { x: 0, y: 0, width: 1440, height: 900 };

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  destroyed = false;
  kiosk = false;
  full = false;
  minimized = false;
  bounds: Rect = { x: 100, y: 100, width: 800, height: 600 };
  calls: string[] = [];
  isDestroyed = () => this.destroyed;
  setKiosk = (f: boolean) => {
    this.kiosk = f;
    this.calls.push(`kiosk:${f}`);
  };
  isKiosk = () => this.kiosk;
  setFullScreen = (f: boolean) => {
    this.full = f;
    this.calls.push(`full:${f}`);
  };
  isFullScreen = () => this.full;
  setAlwaysOnTop = vi.fn();
  setVisibleOnAllWorkspaces = vi.fn();
  setMinimizable = vi.fn();
  setClosable = vi.fn();
  setMovable = vi.fn();
  setResizable = vi.fn();
  isMinimized = () => this.minimized;
  restore = vi.fn(() => {
    this.minimized = false;
  });
  show = vi.fn();
  focus = vi.fn();
  isFocused = () => true;
  getBounds = () => this.bounds;
  setBounds = vi.fn((b: Rect) => {
    this.bounds = b;
  });
}

function setup(mode: RunMode, confirm = true) {
  vi.useFakeTimers();
  const win = new FakeWindow();
  const app = new EventEmitter();
  const deps = {
    getWindow: () => win as unknown as LockdownBrowserWindow,
    getMode: () => mode,
    getPrimaryBounds: () => PRIMARY,
    setLockedMenu: vi.fn(),
    restoreMenu: vi.fn(),
    confirmEmergencyExit: vi.fn(async () => confirm),
    app,
  };
  const lock = createLockdown(deps);
  return { win, app, deps, lock };
}

const input = (key: string, mods: Record<string, boolean> = {}, type = 'keyDown') => ({
  type,
  key,
  ...mods,
});
const sentEvents = (win: FakeWindow) =>
  win.webContents.send.mock.calls.map((c) => (c[1] as { event: string }).event);

function press(win: FakeWindow, i: ReturnType<typeof input>) {
  const event = { preventDefault: vi.fn() };
  win.webContents.emit('before-input-event', event, i);
  return event.preventDefault.mock.calls.length > 0;
}

beforeEach(() => vi.useRealTimers());

describe('enter', () => {
  it('applies the full strict lockdown', () => {
    const { win, lock, deps } = setup('strict');
    lock.enter('a1');
    expect(win.kiosk).toBe(true);
    expect(win.full).toBe(true);
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    for (const f of [win.setMinimizable, win.setClosable, win.setMovable, win.setResizable])
      expect(f).toHaveBeenCalledWith(false);
    expect(deps.setLockedMenu).toHaveBeenCalledOnce();
    expect(lock.isActive()).toBe(true);
    // Fullscreen is requested before kiosk.
    expect(win.calls.indexOf('full:true')).toBeLessThan(win.calls.indexOf('kiosk:true'));
  });

  it('demo is fullscreen without kiosk or always-on-top', () => {
    const { win, lock } = setup('demo');
    lock.enter('a1');
    expect(win.full).toBe(true);
    expect(win.kiosk).toBe(false);
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.setMinimizable).toHaveBeenCalledWith(false);
    expect(win.setClosable).toHaveBeenCalledWith(false);
  });

  it('moves a window on a secondary display to the primary one', () => {
    const { win, lock } = setup('strict');
    win.bounds = { x: 2000, y: 0, width: 800, height: 600 };
    lock.enter('a1');
    expect(win.setBounds).toHaveBeenCalledWith(PRIMARY);
  });

  it('prevents close while locked', () => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('violations', () => {
  it('restores and reports a minimize after the debounce', () => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    win.minimized = true;
    win.full = false;
    win.emit('minimize');
    expect(win.restore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESTORE_DEBOUNCE_MS);
    expect(win.restore).toHaveBeenCalled();
    expect(win.full).toBe(true);
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('lockdown-event', {
      attemptId: 'a1',
      event: 'window_minimize_blocked',
    });
  });

  it('restores fullscreen and kiosk after leave-full-screen', () => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    win.full = false;
    win.kiosk = false;
    win.emit('leave-full-screen');
    vi.advanceTimersByTime(RESTORE_DEBOUNCE_MS);
    expect(win.full).toBe(true);
    expect(win.kiosk).toBe(true);
    expect(sentEvents(win)).toContain('fullscreen_exit_blocked');
  });

  it('coalesces a burst and treats app resign-active as focus loss', () => {
    const { win, app, lock } = setup('strict');
    lock.enter('a1');
    win.emit('blur');
    app.emit('did-resign-active');
    app.emit('browser-window-blur');
    vi.advanceTimersByTime(RESTORE_DEBOUNCE_MS);
    expect(sentEvents(win)).toEqual(['focus_lost']);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('demo logs blur but does not steal focus back', () => {
    const { win, lock } = setup('demo');
    lock.enter('a1');
    win.emit('blur');
    vi.advanceTimersByTime(RESTORE_DEBOUNCE_MS);
    expect(sentEvents(win)).toEqual(['focus_lost']);
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('ignores everything after exit', () => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    lock.exit();
    win.emit('blur');
    win.emit('minimize');
    vi.advanceTimersByTime(1000);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('shortcuts', () => {
  it.each([
    ['m', { meta: true }],
    ['h', { meta: true }],
    ['h', { meta: true, alt: true }],
    ['w', { meta: true }],
    ['q', { meta: true }],
    ['n', { meta: true }],
    ['t', { meta: true }],
    ['r', { meta: true }],
    ['i', { meta: true, alt: true }],
    ['f', { meta: true, control: true }],
  ])('strict blocks %s %o', (key, mods) => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    expect(press(win, input(key, mods))).toBe(true);
  });

  it('does not block ordinary typing or key-up events', () => {
    const { win, lock } = setup('strict');
    lock.enter('a1');
    expect(press(win, input('a'))).toBe(false);
    expect(press(win, input('c', { meta: true }))).toBe(false);
    expect(press(win, input('w', { meta: true }, 'keyUp'))).toBe(false);
    expect(press(win, input('Escape'))).toBe(false);
  });

  it('demo only swallows minimize/hide and leaves other shortcuts alone', () => {
    expect(isBlockedShortcut(input('m', { meta: true }), 'demo')).toBe(true);
    expect(isBlockedShortcut(input('r', { meta: true }), 'demo')).toBe(false);
  });
});

describe('emergency exit', () => {
  it('strict asks for confirmation, logs, and restores everything', async () => {
    const { win, lock, deps } = setup('strict');
    lock.enter('a1');
    expect(press(win, input('q', { meta: true, shift: true }))).toBe(true);
    await vi.waitFor(() => expect(lock.isActive()).toBe(false));
    expect(deps.confirmEmergencyExit).toHaveBeenCalledOnce();
    expect(sentEvents(win)).toContain('lockdown_emergency_exit');
    expect(win.kiosk).toBe(false);
    expect(win.full).toBe(false);
    expect(deps.restoreMenu).toHaveBeenCalled();
    // The same attempt is not re-locked by a repeated start-watcher.
    lock.enter('a1');
    expect(lock.isActive()).toBe(false);
  });

  it('strict stays locked when the student cancels', async () => {
    const { win, lock } = setup('strict', false);
    lock.enter('a1');
    expect(await lock.emergencyExit()).toBe(false);
    expect(lock.isActive()).toBe(true);
    expect(win.kiosk).toBe(true);
    expect(sentEvents(win)).not.toContain('lockdown_emergency_exit');
  });

  it('demo exits on Esc with no dialog', async () => {
    const { win, lock, deps } = setup('demo');
    lock.enter('a1');
    expect(press(win, input('Escape'))).toBe(true);
    await vi.waitFor(() => expect(lock.isActive()).toBe(false));
    expect(deps.confirmEmergencyExit).not.toHaveBeenCalled();
    expect(sentEvents(win)).toContain('lockdown_emergency_exit');
  });
});

describe('exit', () => {
  it('restores normal window behaviour and the menu', () => {
    const { win, lock, deps } = setup('strict');
    lock.enter('a1');
    lock.exit();
    expect(win.kiosk).toBe(false);
    expect(win.full).toBe(false);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    for (const f of [win.setMinimizable, win.setClosable, win.setMovable, win.setResizable])
      expect(f).toHaveBeenLastCalledWith(true);
    expect(deps.restoreMenu).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('exits on app before-quit so quitting is not blocked', () => {
    const { app, lock } = setup('strict');
    lock.enter('a1');
    app.emit('before-quit');
    expect(lock.isActive()).toBe(false);
  });

  it('survives a destroyed window', () => {
    const { win, lock, deps } = setup('strict');
    lock.enter('a1');
    win.destroyed = true;
    expect(() => lock.exit()).not.toThrow();
    expect(deps.restoreMenu).toHaveBeenCalled();
  });
});
