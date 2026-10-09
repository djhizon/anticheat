import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearCache: vi.fn(async () => {}),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose Electron BrowserWindow test doubles
  windows: [] as any[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  execSync: vi.fn(),
  displayHandler: vi.fn(),
  getSources: vi.fn(),
}));
vi.mock('child_process', () => ({ execSync: mocks.execSync }));
vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: () => false,
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('./settings.js', () => ({ readRunMode: () => 'demo', writeRunMode: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    getPath: () => '/tmp',
    quit: vi.fn(),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = new EventEmitter();
    destroyed = false;
    loadURL = vi.fn(async (_url: string) => {});
    maximize() {}
    setContentProtection() {}
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    constructor() {
      super();
      mocks.windows.push(this);
    }
  },
  screen: {},
  ipcMain: {
    on: vi.fn(),
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  session: {
    defaultSession: {
      clearCache: mocks.clearCache,
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: mocks.displayHandler,
    },
  },
  desktopCapturer: { getSources: mocks.getSources },
  shell: { openPath: vi.fn() },
  systemPreferences: {},
  dialog: { showMessageBox: mocks.showMessageBox },
}));

import { screen } from 'electron';
import { createWindow, switchRunMode } from './main.js';
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('native window recovery', () => {
  it('refuses legacy force-close requests without invoking an OS command', async () => {
    mocks.execSync.mockClear();
    const handler = mocks.handlers.get('kill-app');
    expect(handler).toBeDefined();
    for (const target of ['Exam Anti-Cheat', 'Electron', 'Terminal', 'Notes', null]) {
      expect(await handler!({}, target)).toBe(false);
    }
    expect(mocks.execSync).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    mocks.displayHandler.mockClear();
    mocks.getSources.mockReset();
    mocks.windows.length = 0;
    mocks.clearCache.mockReset().mockResolvedValue(undefined);
    mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  });
  function displayRequest() {
    const frame = { url: 'http://127.0.0.1:5173/' };
    mocks.windows[0].webContents.mainFrame = frame;
    return {
      frame,
      securityOrigin: 'http://127.0.0.1:5173',
      userGesture: true,
      videoRequested: true,
      audioRequested: false,
    };
  }
  it('grants only an explicitly selected screen with no system audio', async () => {
    await createWindow();
    const source = { id: 'screen:1', name: 'Display' };
    mocks.getSources.mockResolvedValue([source]);
    const callback = vi.fn();
    mocks.displayHandler.mock.calls[0]![0](displayRequest(), callback);
    await flush();
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    expect(mocks.showMessageBox.mock.calls.at(-1)?.[1]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ video: source });
  });
  it('records the primary screen without a picker after the in-app opt-in click', async () => {
    await createWindow();
    const primary = { id: 'screen:2', name: 'Main', display_id: '2' };
    mocks.getSources.mockResolvedValue([
      { id: 'screen:1', name: 'Other', display_id: '1' },
      primary,
    ]);
    (screen as unknown as { getPrimaryDisplay: () => { id: number } }).getPrimaryDisplay = () => ({
      id: 2,
    });
    const handler = mocks.displayHandler.mock.calls[0]![0];
    const callback = vi.fn();
    handler(displayRequest(), callback);
    await flush();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ video: primary });
    for (const change of [{ userGesture: false }, { audioRequested: true }, { frame: null }]) {
      const denied = vi.fn();
      handler({ ...displayRequest(), ...change }, denied);
      await flush();
      expect(denied).toHaveBeenCalledExactlyOnceWith({});
    }
    delete (screen as unknown as Record<string, unknown>).getPrimaryDisplay;
  });
  it('denies cancelled selection and requests without a click, from subframes or for audio', async () => {
    await createWindow();
    mocks.getSources.mockResolvedValue([{ id: 'screen:1', name: 'Display' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    const handler = mocks.displayHandler.mock.calls[0]![0];
    for (const change of [
      {},
      { userGesture: false },
      { audioRequested: true },
      { frame: null },
      { securityOrigin: 'https://other.test' },
    ]) {
      const callback = vi.fn();
      handler({ ...displayRequest(), ...change }, callback);
      await flush();
      expect(callback).toHaveBeenCalledExactlyOnceWith({});
    }
  });
  it('rejects overlapping requests without releasing the first picker lock', async () => {
    await createWindow();
    const source = { id: 'screen:1', name: 'Display' };
    mocks.getSources.mockResolvedValue([source]);
    let resolve!: (value: { response: number }) => void;
    mocks.showMessageBox.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const handler = mocks.displayHandler.mock.calls[0]![0];
    const request = displayRequest();
    const first = vi.fn();
    handler(request, first);
    await flush();
    for (let i = 0; i < 2; i++) {
      const denied = vi.fn();
      handler(request, denied);
      expect(denied).toHaveBeenCalledExactlyOnceWith({});
    }
    expect(mocks.getSources).toHaveBeenCalledTimes(1);
    resolve({ response: 1 });
    await flush();
    expect(first).toHaveBeenCalledExactlyOnceWith({ video: source });
    const next = vi.fn();
    handler(request, next);
    await flush();
    resolve({ response: 0 });
    await flush();
    expect(next).toHaveBeenCalledExactlyOnceWith({});
  });
  it('rejects selection after navigation while the picker is open', async () => {
    await createWindow();
    mocks.getSources.mockResolvedValue([{ id: 'screen:1', name: 'Display' }]);
    let resolve!: (value: { response: number }) => void;
    mocks.showMessageBox.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const callback = vi.fn();
    mocks.displayHandler.mock.calls[0]![0](displayRequest(), callback);
    await flush();
    mocks.windows[0].webContents.emit(
      'did-start-navigation',
      {},
      'http://127.0.0.1:5173/',
      false,
      true,
    );
    resolve({ response: 1 });
    await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith({});
  });
  it('refuses app-control calls from other windows, subframes and unexpected URLs', async () => {
    await createWindow();
    const webContents = mocks.windows[0].webContents;
    const frame = { url: 'http://127.0.0.1:5173/' };
    webContents.mainFrame = frame;
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: { url: frame.url } },
      { sender: webContents, senderFrame: undefined },
    ]) {
      expect(() => mocks.handlers.get('list-app-targets')!(event)).toThrow('Untrusted');
      expect(() =>
        mocks.handlers.get('close-app-target')!(event, { id: 'fake', mode: 'quit' }),
      ).toThrow('Untrusted');
    }
    frame.url = 'http://127.0.0.1:5173/untrusted';
    expect(() =>
      mocks.handlers.get('list-app-targets')!({ sender: webContents, senderFrame: frame }),
    ).toThrow('Untrusted');
  });
  it('still loads the page if cache clearing fails', async () => {
    mocks.clearCache.mockRejectedValue(new Error('cache unavailable'));
    await createWindow();
    expect(mocks.windows[0].loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/');
  });
  it('offers recovery again when a requested reload fails', async () => {
    await createWindow();
    const window = mocks.windows[0];
    mocks.showMessageBox
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 });
    window.loadURL.mockImplementation(async () => {
      window.webContents.emit('did-fail-load', {}, -102, 'refused', 'http://127.0.0.1:5173/', true);
      throw new Error('refused');
    });
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await flush();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(window.isDestroyed()).toBe(true);
  });
  it('closes the unusable window if the native dialog itself fails', async () => {
    await createWindow();
    mocks.showMessageBox.mockRejectedValue(new Error('dialog unavailable'));
    const window = mocks.windows[0];
    window.emit('unresponsive');
    await flush();
    expect(window.isDestroyed()).toBe(true);
  });
  describe('run mode', () => {
    async function trustedEvent() {
      await createWindow();
      const webContents = mocks.windows.at(-1).webContents;
      const frame = { url: 'http://127.0.0.1:5173/' };
      webContents.mainFrame = frame;
      return { sender: webContents, senderFrame: frame };
    }
    it('defaults to demo and refuses close-app-target without quitting anything', async () => {
      const event = await trustedEvent();
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('demo');
      const result = (await mocks.handlers.get('close-app-target')!(event, {
        id: 'x',
        mode: 'quit',
      })) as { status: string; message: string };
      expect(result.status).toBe('refused');
      expect(result.message).toContain('Demo mode');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });
    it('exposes the mode only to the trusted frame', async () => {
      const event = await trustedEvent();
      expect(() => mocks.handlers.get('get-run-mode')!({ ...event, sender: {} })).toThrow(
        'Untrusted',
      );
    });
    it('asks for confirmation before strict, and strict keeps the existing behaviour', async () => {
      const event = await trustedEvent();
      mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
      await switchRunMode('strict');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('demo');
      await switchRunMode('strict');
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('strict');
      const result = (await mocks.handlers.get('close-app-target')!(event, {
        id: 'unknown',
        mode: 'quit',
      })) as { status: string; message: string };
      expect(result.message).not.toContain('Demo mode');
      expect(() => mocks.handlers.get('close-app-target')!(event, { id: 'x' })).toThrow('Invalid');
      await switchRunMode('demo'); // Back to demo needs no confirmation.
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('demo');
    });
  });
});
