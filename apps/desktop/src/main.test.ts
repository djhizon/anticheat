import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearCache: vi.fn(async () => {}),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose Electron BrowserWindow test doubles
  windows: [] as any[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  writeRunMode: vi.fn(),
  showErrorBox: vi.fn(),
  quit: vi.fn(),
  hasSwitch: vi.fn((_name: string) => false),
  appState: { isPackaged: false },
  permissionRequest: vi.fn(),
  permissionCheck: vi.fn(),
  displayHandler: vi.fn(),
  getSources: vi.fn(),
}));
vi.mock('child_process', () => ({ execSync: mocks.execSync, execFile: mocks.execFile }));
vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: () => false,
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('./settings.js', () => ({
  readRunMode: (_dir: string, fallback: string) => fallback,
  readJudgeBuild: () => false,
  persistRunMode: (judge: boolean) => judge,
  writeRunMode: mocks.writeRunMode,
}));
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    getPath: () => '/tmp',
    getAppPath: () => '/app',
    get isPackaged() {
      return mocks.appState.isPackaged;
    },
    quit: mocks.quit,
    commandLine: { hasSwitch: mocks.hasSwitch },
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
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
    options: unknown;
    constructor(options?: unknown) {
      super();
      this.options = options;
      mocks.windows.push(this);
    }
  },
  screen: {},
  ipcMain: {
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.listeners.set(name, handler),
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  session: {
    defaultSession: {
      clearCache: mocks.clearCache,
      setPermissionRequestHandler: mocks.permissionRequest,
      setPermissionCheckHandler: mocks.permissionCheck,
      setDisplayMediaRequestHandler: mocks.displayHandler,
    },
  },
  desktopCapturer: { getSources: mocks.getSources },
  shell: { openPath: vi.fn() },
  systemPreferences: {},
  dialog: { showMessageBox: mocks.showMessageBox, showErrorBox: mocks.showErrorBox },
}));

import { screen } from 'electron';
import {
  createWindow,
  isAppUrl,
  refusesRemoteDebugging,
  reportStartupFailure,
  shouldUseDevServers,
  startApp,
  switchRunMode,
} from './main.js';
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('native window recovery', () => {
  it('refuses legacy force-close requests without invoking an OS command', async () => {
    mocks.execSync.mockClear();
    const handler = mocks.handlers.get('kill-app');
    expect(handler).toBeDefined();
    for (const target of ['ExamGuard', 'Electron', 'Terminal', 'Notes', null]) {
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
    mocks.writeRunMode.mockClear();
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
  describe('window hardening', () => {
    it('denies every window.open request', async () => {
      await createWindow();
      const handler = mocks.windows.at(-1).webContents.setWindowOpenHandler.mock.calls[0][0];
      expect(handler({ url: 'https://example.test' })).toEqual({ action: 'deny' });
    });
    it('grants only media and display-capture to the app origin in the app window', async () => {
      mocks.permissionRequest.mockClear();
      mocks.permissionCheck.mockClear();
      await createWindow();
      const webContents = mocks.windows.at(-1).webContents;
      const request = mocks.permissionRequest.mock.calls.at(-1)![0];
      const decide = (contents: unknown, permission: string, url: string) => {
        const callback = vi.fn();
        request(contents, permission, callback, { requestingUrl: url });
        return callback.mock.calls[0]![0];
      };
      expect(decide(webContents, 'media', 'http://127.0.0.1:5173/')).toBe(true);
      expect(decide(webContents, 'display-capture', 'http://127.0.0.1:5173/x')).toBe(true);
      for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'openExternal'])
        expect(decide(webContents, permission, 'http://127.0.0.1:5173/')).toBe(false);
      expect(decide(webContents, 'media', 'https://evil.test/')).toBe(false);
      expect(decide({}, 'media', 'http://127.0.0.1:5173/')).toBe(false);
      const check = mocks.permissionCheck.mock.calls.at(-1)![0];
      expect(check(webContents, 'media', 'http://127.0.0.1:5173')).toBe(true);
      expect(check(webContents, 'media', 'https://evil.test')).toBe(false);
      expect(check(webContents, 'geolocation', 'http://127.0.0.1:5173')).toBe(false);
    });
  });
  describe('dev-server guard', () => {
    it('honours the flag and env only when not packaged', () => {
      expect(shouldUseDevServers(false, ['--use-dev-servers'], {})).toBe(true);
      expect(shouldUseDevServers(false, [], { EAC_USE_DEV_SERVERS: '1' })).toBe(true);
      expect(shouldUseDevServers(false, [], {})).toBe(false);
      expect(shouldUseDevServers(true, ['--use-dev-servers'], {})).toBe(false);
      expect(shouldUseDevServers(true, [], { EAC_USE_DEV_SERVERS: '1' })).toBe(false);
    });
  });
  describe('window hardening', () => {
    it('sets sandbox/no webview and blocks every non-app navigation kind', async () => {
      await createWindow();
      const win = mocks.windows.at(-1);
      expect(win.options.webPreferences).toMatchObject({
        sandbox: true,
        webviewTag: false,
        contextIsolation: true,
        nodeIntegration: false,
      });
      for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
        const blocked = { preventDefault: vi.fn() };
        win.webContents.emit(name, blocked, 'https://evil.test/');
        const blockedDetails = { preventDefault: vi.fn(), url: 'https://evil.test/' };
        win.webContents.emit(name, blockedDetails);
        expect(blockedDetails.preventDefault, name).toHaveBeenCalled();
        expect(blocked.preventDefault, name).toHaveBeenCalled();
        const samePathOther = { preventDefault: vi.fn() };
        win.webContents.emit(name, samePathOther, 'http://127.0.0.1:5173/other');
        expect(samePathOther.preventDefault, name).toHaveBeenCalled();
        const allowed = { preventDefault: vi.fn() };
        win.webContents.emit(name, allowed, 'http://127.0.0.1:5173/?a=1');
        expect(allowed.preventDefault, name).not.toHaveBeenCalled();
      }
    });
  });
  describe('ipc trust', () => {
    async function trusted() {
      await createWindow();
      const webContents = mocks.windows.at(-1).webContents;
      const frame = { url: 'http://127.0.0.1:5173/' };
      webContents.mainFrame = frame;
      return { sender: webContents, senderFrame: frame, webContents };
    }
    it('compares frame URLs by origin and pathname', () => {
      expect(isAppUrl('http://127.0.0.1:5173/')).toBe(true);
      expect(isAppUrl('http://127.0.0.1:5173/?x=1#y')).toBe(true);
      expect(isAppUrl('http://127.0.0.1:5173/other')).toBe(false);
      expect(isAppUrl('http://localhost:5173/')).toBe(false);
      expect(isAppUrl('http://127.0.0.1:5174/')).toBe(false);
      expect(isAppUrl('not a url')).toBe(false);
      expect(isAppUrl(undefined)).toBe(false);
    });
    it('camera-attestation is wired to the trusted app frame check', async () => {
      const event = await trusted();
      const handler = mocks.handlers.get('camera-attestation')!;
      expect(() => handler({ ...event, sender: {} }, 'FaceTime HD Camera')).toThrow('Untrusted');
      expect(() =>
        handler(
          { sender: event.sender, senderFrame: { url: event.senderFrame.url } },
          'FaceTime HD Camera',
        ),
      ).toThrow('Untrusted');
      expect(() => handler(event, 42)).toThrow('Invalid');
    });
    it('rejects untrusted callers on every get-* handler', async () => {
      const event = await trusted();
      (screen as unknown as Record<string, unknown>).getAllDisplays = () => [{}];
      try {
        for (const name of ['get-display-count', 'get-environment-risk', 'get-foreground-app']) {
          const handler = mocks.handlers.get(name)!;
          expect(() => handler({ ...event, sender: {} })).toThrow('Untrusted');
          expect(() =>
            handler({ sender: event.sender, senderFrame: { url: event.senderFrame.url } }),
          ).toThrow('Untrusted');
          expect(() => handler(event)).not.toThrow();
        }
        expect(mocks.handlers.get('get-display-count')!(event)).toBe(1);
        // A query string on the same page is still the trusted app page.
        event.senderFrame.url = 'http://127.0.0.1:5173/?q=1';
        expect(mocks.handlers.get('get-display-count')!(event)).toBe(1);
        event.senderFrame.url = 'http://127.0.0.1:5173/elsewhere';
        expect(() => mocks.handlers.get('get-display-count')!(event)).toThrow('Untrusted');
      } finally {
        delete (screen as unknown as Record<string, unknown>).getAllDisplays;
      }
    });
    it('ignores watcher requests from untrusted callers or with a bad attempt id', async () => {
      vi.useFakeTimers();
      try {
        mocks.execFile.mockClear();
        mocks.execFile.mockImplementation(
          (
            _file: string,
            _args: string[],
            _options: unknown,
            callback: (...a: unknown[]) => void,
          ) => callback(new Error('unavailable'), ''),
        );
        const event = await trusted();
        const start = mocks.listeners.get('start-watcher')!;
        const stop = mocks.listeners.get('stop-watcher')!;
        start({ ...event, sender: {} }, 'a1');
        for (const bad of [undefined, 42, '', 'x'.repeat(201), { id: 1 }]) start(event, bad);
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.execFile).not.toHaveBeenCalled();

        start(event, 'a1');
        await vi.advanceTimersByTimeAsync(2100);
        expect(mocks.execFile).toHaveBeenCalled(); // async execFile, never execSync, per tick
        stop({ ...event, sender: {} }); // Untrusted stop is ignored.
        mocks.execFile.mockClear();
        await vi.advanceTimersByTimeAsync(2100);
        expect(mocks.execFile).toHaveBeenCalled();
        stop(event);
        mocks.execFile.mockClear();
        await vi.advanceTimersByTimeAsync(5000);
        expect(mocks.execFile).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
    it('sends the run mode with each snapshot', async () => {
      vi.useFakeTimers();
      try {
        mocks.execFile.mockImplementation(
          (
            _file: string,
            _args: string[],
            _options: unknown,
            callback: (...a: unknown[]) => void,
          ) => callback(null, '"Notes" ASN:1-2'),
        );
        const event = await trusted();
        const send = vi.fn();
        event.webContents.send = send;
        (screen as unknown as Record<string, unknown>).getAllDisplays = () => [{}];
        mocks.listeners.get('start-watcher')!(event, 'a1');
        await vi.advanceTimersByTimeAsync(2100);
        mocks.listeners.get('stop-watcher')!(event);
        delete (screen as unknown as Record<string, unknown>).getAllDisplays;
        expect(send).toHaveBeenCalledWith(
          'app-snapshot',
          expect.objectContaining({ attemptId: 'a1', runMode: 'strict', displayCount: 1 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
  describe('remote debugging guard', () => {
    const port = ['/app', '--remote-debugging-port=0'];
    const pipe = ['/app', '--remote-debugging-pipe'];
    it('refuses the DevTools switches only in a packaged non-judge build', () => {
      expect(refusesRemoteDebugging(true, false, port)).toBe(true);
      expect(refusesRemoteDebugging(true, false, pipe)).toBe(true);
      expect(refusesRemoteDebugging(true, false, ['/app', '--remote-debugging-port'])).toBe(true);
      expect(refusesRemoteDebugging(true, false, ['/app', '--user-data-dir=/x'])).toBe(false);
      // A look-alike flag is not the switch.
      expect(refusesRemoteDebugging(true, false, ['/app', '--remote-debugging-portal=1'])).toBe(
        false,
      );
      // Chromium's own parse is consulted too (the switch may be spelled in a way argv misses).
      expect(refusesRemoteDebugging(true, false, [], (n) => n === 'remote-debugging-port')).toBe(
        true,
      );
      // The packaged judge build (automated tests) and the unpackaged dev build may use it.
      expect(refusesRemoteDebugging(true, true, port)).toBe(false);
      expect(refusesRemoteDebugging(false, false, port)).toBe(false);
      expect(refusesRemoteDebugging(false, false, pipe)).toBe(false);
    });
    it('quits with an error before starting any server or window when refused', async () => {
      const argv = process.argv;
      mocks.appState.isPackaged = true;
      mocks.showErrorBox.mockClear();
      mocks.quit.mockClear();
      mocks.windows.length = 0;
      process.argv = ['/app', '--remote-debugging-port=9222'];
      try {
        await startApp();
      } finally {
        process.argv = argv;
        mocks.appState.isPackaged = false;
      }
      expect(mocks.showErrorBox).toHaveBeenCalledTimes(1);
      expect(mocks.showErrorBox.mock.calls[0]?.[0]).toContain('remote debugging');
      expect(mocks.quit).toHaveBeenCalledTimes(1);
      expect(mocks.windows).toHaveLength(0);
    });
  });
  describe('startup failure', () => {
    it('logs, shows an error dialog and quits', () => {
      mocks.showErrorBox.mockClear();
      mocks.quit.mockClear();
      reportStartupFailure(new Error('boom'));
      expect(mocks.showErrorBox).toHaveBeenCalledTimes(1);
      expect(mocks.quit).toHaveBeenCalledTimes(1);
    });
    it('still quits if the dialog itself fails', () => {
      mocks.quit.mockClear();
      mocks.showErrorBox.mockImplementationOnce(() => {
        throw new Error('no ui');
      });
      reportStartupFailure('x');
      expect(mocks.quit).toHaveBeenCalledTimes(1);
    });
  });
  describe('run mode', () => {
    async function trustedEvent() {
      await createWindow();
      const webContents = mocks.windows.at(-1).webContents;
      const frame = { url: 'http://127.0.0.1:5173/' };
      webContents.mainFrame = frame;
      return { sender: webContents, senderFrame: frame };
    }
    it('defaults to strict in a non-judge build and does not refuse close requests as demo', async () => {
      const event = await trustedEvent();
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('strict');
      expect(mocks.writeRunMode).not.toHaveBeenCalled();
    });
    it('exposes the mode only to the trusted frame', async () => {
      const event = await trustedEvent();
      expect(() => mocks.handlers.get('get-run-mode')!({ ...event, sender: {} })).toThrow(
        'Untrusted',
      );
    });
    it('serves the demo info and phone LAN requests only to the trusted frame', async () => {
      const event = await trustedEvent();
      for (const name of ['get-demo-info', 'start-phone-lan'])
        expect(() => mocks.handlers.get(name)!({ ...event, sender: {} })).toThrow('Untrusted');
      mocks.execFile.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
          cb(null, JSON.stringify({ exemptions: ['Terminal'] })),
      );
      expect(await mocks.handlers.get('get-demo-info')!(event)).toEqual({
        exemptApps: ['Terminal'],
        packaged: false,
      });
    });
    it('confirms both directions, does not persist in non-judge builds, and demo never closes apps', async () => {
      const event = await trustedEvent();
      // Strict -> Demo, cancelled.
      mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
      await switchRunMode('demo');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox.mock.calls[0]?.[1]).toMatchObject({
        title: 'Switch to Demo mode?',
        defaultId: 0,
        cancelId: 0,
      });
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('strict');
      expect(mocks.writeRunMode).not.toHaveBeenCalled();
      // Strict -> Demo, confirmed.
      await switchRunMode('demo');
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('demo');
      // Non-judge build: the in-app Demo choice is session-only and never written to disk.
      expect(mocks.writeRunMode).not.toHaveBeenCalled();
      const refused = (await mocks.handlers.get('close-app-target')!(event, {
        id: 'x',
        mode: 'quit',
      })) as { status: string; message: string };
      expect(refused.status).toBe('refused');
      expect(refused.message).toContain('Demo mode');
      // Demo -> Strict, cancelled then confirmed.
      mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
      await switchRunMode('strict');
      expect(mocks.showMessageBox.mock.calls[2]?.[1]).toMatchObject({
        title: 'Switch to Strict mode?',
      });
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('demo');
      await switchRunMode('strict');
      expect(await mocks.handlers.get('get-run-mode')!(event)).toBe('strict');
      expect(mocks.writeRunMode).not.toHaveBeenCalled();
      const result = (await mocks.handlers.get('close-app-target')!(event, {
        id: 'unknown',
        mode: 'quit',
      })) as { status: string; message: string };
      expect(result.message).not.toContain('Demo mode');
      expect(() => mocks.handlers.get('close-app-target')!(event, { id: 'x' })).toThrow('Invalid');
      // Switching to the current mode does nothing.
      mocks.showMessageBox.mockClear();
      await switchRunMode('strict');
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });
  });
});
