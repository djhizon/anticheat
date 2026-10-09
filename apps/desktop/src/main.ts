import {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  Menu,
  globalShortcut,
  session,
  systemPreferences,
  dialog,
  desktopCapturer,
  shell,
  utilityProcess,
} from 'electron';

import { execFile, execSync } from 'child_process';
import * as path from 'path';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { createAppController, createHelperCall } from './appControl';
import { classifyDisplays, detectVirtualMachine } from './environment';
import { defaultRunMode, mayCloseApps, planModeSwitch, type RunMode } from './mode';
import { readJudgeBuild, readRunMode, writeRunMode } from './settings';
import {
  checkCanConnect,
  checkPortFree,
  nodeChildProcess,
  startRuntime,
  type RuntimeHandle,
} from './runtime';

const WEB_URL = 'http://127.0.0.1:5173/';
const APP_WATCH_INTERVAL_MS = 2000;

let mainWindow: BrowserWindow | null = null;
let watcherInterval: ReturnType<typeof setInterval> | null = null;
// Strict is the default everywhere except the packaged judge build; the build default and the
// persisted choice are resolved once the app is ready.
let judgeBuild = false;
let runMode: RunMode = defaultRunMode(false);
let appController: ReturnType<typeof createAppController> | null = null;
let runtime: RuntimeHandle | null = null;

// `npm run dev` keeps using the Vite + API dev servers; otherwise the bundled server is started.
const useDevServers =
  process.argv.includes('--use-dev-servers') || process.env.EAC_USE_DEV_SERVERS === '1';

/** Same origin and path as the app page; query/hash differences (e.g. SPA state) are tolerated. */
export function isAppUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const candidate = new URL(url);
    const expected = new URL(WEB_URL);
    return candidate.origin === expected.origin && candidate.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function isAppOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).origin === new URL(WEB_URL).origin;
  } catch {
    return false;
  }
}

interface FrameEvent {
  sender: unknown;
  senderFrame?: { url: string } | null;
}

function trustedAppFrame(event: FrameEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame !== undefined &&
    event.senderFrame !== null &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isAppUrl(event.senderFrame.url)
  );
}

function validAttemptId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 1000, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

// Store only fixed lifecycle categories/codes, never URLs, answers, credentials,
// console output or application names. Bound the local diagnostic file size.
function diagnostic(event: string, detail: string | number = ''): void {
  try {
    const file = path.join(app.getPath('userData'), 'desktop-health.log');
    if (existsSync(file) && statSync(file).size > 65536) writeFileSync(file, '');
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`);
  } catch {
    /* Diagnostics must never prevent the recovery UI. */
  }
}

async function getForegroundApp(): Promise<string> {
  try {
    const asn = (await run('lsappinfo', ['front'])).trim();
    if (!/^[A-Za-z0-9:-]+$/.test(asn)) return 'unknown';
    const output = await run('lsappinfo', ['info', asn]);
    const match = output.match(/"([^"]+)" ASN/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function getDisplayCount(): number {
  return screen.getAllDisplays().length;
}

function getCaptureDisplays(): string[] {
  try {
    return classifyDisplays(
      screen.getAllDisplays() as unknown as Parameters<typeof classifyDisplays>[0],
    ).captureLike;
  } catch {
    return [];
  }
}

function getEnvironmentRisk(): { virtualMachine: string | null; captureDisplays: string[] } {
  let virtualMachine: string | null = null;
  try {
    virtualMachine = detectVirtualMachine((cmd) =>
      execSync(cmd, { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
    ).reason;
  } catch {
    virtualMachine = null;
  }
  return { virtualMachine, captureDisplays: getCaptureDisplays() };
}

function startWatcher(attemptId: string): void {
  if (watcherInterval) clearInterval(watcherInterval);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; // Never stack slow helper calls.
    busy = true;
    void (async () => {
      try {
        const foreground = await getForegroundApp();
        if (watcherInterval !== timer) return; // Stopped or replaced while waiting.
        // Hand the snapshot to the renderer, which posts it with the student's
        // session cookie and CSRF token. The main process holds no credentials.
        // The run mode travels along so it is recorded with the attempt.
        mainWindow?.webContents.send('app-snapshot', {
          attemptId,
          foregroundApp: foreground,
          displayCount: getDisplayCount(),
          captureDisplays: getCaptureDisplays(),
          runMode,
        });
      } catch {
        /* A failed tick is skipped. */
      } finally {
        busy = false;
      }
    })();
  }, APP_WATCH_INTERVAL_MS);
  watcherInterval = timer;
}

function stopWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.on('renderer-failure', (event) => {
  if (event.sender === mainWindow?.webContents) diagnostic('renderer-javascript-error');
});

ipcMain.handle('list-app-targets', (event) => {
  if (!trustedAppFrame(event) || !appController) throw new Error('Untrusted application request.');
  return appController.list();
});
ipcMain.handle('get-run-mode', (event) => {
  if (!trustedAppFrame(event)) throw new Error('Untrusted application request.');
  return runMode;
});
ipcMain.handle('close-app-target', (event, request: unknown) => {
  if (!trustedAppFrame(event) || !appController || !request || typeof request !== 'object')
    throw new Error('Untrusted application request.');
  const input = request as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'id,mode')
    throw new Error('Invalid application request.');
  // Demo mode never quits anything, whatever the renderer asks for.
  if (!mayCloseApps(runMode))
    return { status: 'refused', message: 'Demo mode: no applications are closed.' };
  return appController.close(input.id, input.mode);
});

// Older renderer/preload copies may still send this message. Refuse it without
// inspecting or signalling processes: display names are not safe PID identities.
ipcMain.handle('kill-app', () => false);

export async function switchRunMode(target: RunMode): Promise<void> {
  const plan = planModeSwitch(runMode, target);
  if (!plan.change) return;
  if (plan.confirm) {
    const toStrict = target === 'strict';
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: toStrict ? 'Switch to Strict mode?' : 'Switch to Demo mode?',
      message: toStrict
        ? 'Strict mode can ask other applications to quit.'
        : 'Demo mode turns off the exam environment checks.',
      detail: toStrict
        ? 'The pre-flight check will block until other apps are closed. Save your work first. Demo mode never closes or blocks anything.'
        : 'Nothing will be closed or blocked, and the attempt is marked as taken in Demo mode in the transparency report. Use it only for trying the app, not for a real exam.',
      buttons: ['Cancel', toStrict ? 'Switch to Strict' : 'Switch to Demo'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const response =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
    if (response.response !== 1) return;
  }
  runMode = target;
  try {
    writeRunMode(app.getPath('userData'), runMode);
  } catch {
    diagnostic('settings-write-failed');
  }
  buildAppMenu();
  // Reload so the pre-flight check runs again under the new mode.
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(WEB_URL).catch(() => {});
}

// Keep an OS-owned exit available even when the renderer crashes.
function buildAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Exam Anti-Cheat', submenu: [{ role: 'quit' }] },
      {
        label: 'Mode',
        submenu: [
          {
            label: 'Mode: Demo',
            type: 'radio',
            checked: runMode === 'demo',
            click: () => void switchRunMode('demo'),
          },
          {
            label: 'Mode: Strict',
            type: 'radio',
            checked: runMode === 'strict',
            click: () => void switchRunMode('strict'),
          },
          { type: 'separator' },
          {
            label: 'Open logs folder',
            click: () => {
              void shell.openPath(app.getPath('userData'));
            },
          },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {
        label: 'Window',
        submenu: [
          {
            label: 'Reload application',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              void mainWindow?.loadURL(WEB_URL).catch(() => {});
            },
          },
          { role: 'toggleDevTools' },
          { role: 'minimize' },
          { role: 'close' },
        ],
      },
    ]),
  );
}

export async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minimizable: true,
    resizable: true,
    movable: true,
    kiosk: false,
    fullscreen: false,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Exam Anti-Cheat',
  });

  mainWindow.maximize();

  mainWindow.setContentProtection(true);

  // Never open extra windows (target=_blank, window.open); they would escape the exam shell.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(WEB_URL).origin) {
      event.preventDefault();
    }
  });

  buildAppMenu();

  const window = mainWindow;
  let navigationGeneration = 0;
  appController = createAppController({
    call: createHelperCall(
      app.isPackaged
        ? path.join(process.resourcesPath, 'app-control')
        : path.join(__dirname, '../native-bin/app-control'),
      () => runMode === 'demo',
    ),
    confirm: async (name, mode) => {
      if (window.isDestroyed()) return false;
      const response = await dialog.showMessageBox(window, {
        type: 'warning',
        title: mode === 'quit' ? 'Quit application?' : 'Force Quit application?',
        message: `${mode === 'quit' ? 'Request a normal quit of' : 'Force Quit'} ${name}?`,
        detail:
          mode === 'quit'
            ? 'Save your work first. The app may ask you to save or cancel.'
            : 'Unsaved work may be permanently lost. This closes the app without a normal save prompt.',
        buttons: ['Cancel', mode === 'quit' ? 'Quit normally' : 'Force Quit'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response.response === 1 && !window.isDestroyed();
    },
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      navigationGeneration++;
      appController?.reset();
    }
  });
  let showingRecovery = false;
  const recover = async (reason: string): Promise<void> => {
    if (showingRecovery || window.isDestroyed()) return;
    showingRecovery = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Exam window needs recovery',
        message: reason,
        detail:
          'No exam data has been reset. Check that the local servers are running. You can reload or close the application.',
        buttons: ['Reload', 'Close'],
        defaultId: 0,
        cancelId: 1,
      });
      if (window.isDestroyed()) return;
      // Release before navigating: a failed retry must be allowed to display
      // another recovery dialog instead of being discarded as a duplicate.
      showingRecovery = false;
      if (result.response === 0)
        void window.loadURL(WEB_URL).catch(() => {
          void recover('The exam page still could not be loaded.');
        });
      else window.destroy();
    } catch {
      diagnostic('recovery-dialog-failed');
      // If even the native dialog fails, close this unusable window rather
      // than leave a blank renderer. Saved exam data is untouched.
      if (!window.isDestroyed()) window.destroy();
    } finally {
      showingRecovery = false;
    }
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    appController?.reset();
    diagnostic('renderer-exit', details.reason);
    void recover('The exam renderer stopped unexpectedly.');
  });
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    diagnostic('load-failed', code);
    void recover('The exam page could not be loaded.');
  });
  window.webContents.on('did-finish-load', () => diagnostic('page-loaded'));
  window.on('unresponsive', () => {
    diagnostic('window-unresponsive');
    void recover('The exam window is not responding.');
  });
  diagnostic('window-created');

  // Only the app page may use the camera, microphone and (via the handler below) screen capture.
  const allowedPermissions = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        webContents === window.webContents &&
          allowedPermissions.has(permission) &&
          isAppOrigin(details?.requestingUrl),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      webContents === window.webContents &&
      allowedPermissions.has(permission) &&
      isAppOrigin(requestingOrigin),
  );

  // Electron needs a source-selection handler; granting generic media permission
  // alone does not implement getDisplayMedia. The request is only honoured for a
  // trusted app frame with a user gesture (the student's explicit "Start recording"
  // click inside the consented exam). In that case the primary screen is used
  // without a second picker; if it cannot be identified, the picker is shown.
  let screenPickerOpen = false;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (screenPickerOpen) {
      callback({});
      return;
    }
    screenPickerOpen = true;
    const generation = navigationGeneration;
    let settled = false;
    const finish = (streams: Electron.Streams) => {
      if (settled) return;
      settled = true;
      screenPickerOpen = false;
      try {
        callback(streams);
      } catch {
        /* Requesting frame may have closed. */
      }
    };
    const trusted = () =>
      !window.isDestroyed() &&
      mainWindow === window &&
      generation === navigationGeneration &&
      request.frame !== null &&
      request.frame === window.webContents.mainFrame &&
      isAppUrl(request.frame.url) &&
      request.securityOrigin === new URL(WEB_URL).origin &&
      request.userGesture &&
      request.videoRequested &&
      !request.audioRequested;
    void (async () => {
      try {
        if (!trusted()) return finish({});
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!trusted() || sources.length === 0) return finish({});
        let primaryId: string | null = null;
        try {
          primaryId = String(screen.getPrimaryDisplay().id);
        } catch {
          /* Fall back to the explicit picker. */
        }
        const primary = primaryId
          ? sources.find((source) => source.display_id === primaryId)
          : undefined;
        if (primary) return finish({ video: primary }); // No system/loopback audio.
        const choice = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'Exam screen recording',
          message: 'Choose a screen to record on this Mac',
          detail:
            "Everything visible on the selected screen may be recorded. Segments upload to your school's secure OneDrive for exam review, or are saved on this computer if the connection is poor. The built-in microphone is requested separately. Cancel does not start capture.",
          buttons: [
            'Cancel',
            ...sources.map((source, index) => `Record screen ${index + 1}: ${source.name}`),
          ],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        const selected = sources[choice.response - 1];
        if (!trusted() || !selected) return finish({});
        finish({ video: selected }); // No system/loopback audio.
      } catch {
        finish({});
      }
    })();
  });

  // Clear cache to ensure fresh UI loads from dev server
  await session.defaultSession.clearCache().catch(() => diagnostic('cache-clear-failed'));
  if (!window.isDestroyed()) await window.loadURL(WEB_URL).catch(() => {});

  // Emergency exit: Cmd+Shift+Q (macOS)
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    mainWindow?.webContents.send('emergency-exit');
    setTimeout(() => {
      globalShortcut.unregisterAll();
      app.quit();
    }, 2000);
  });

  mainWindow.on('closed', () => {
    appController?.reset();
    appController = null;
    mainWindow = null;
    stopWatcher();
  });
}

ipcMain.on('start-watcher', (event, attemptId: unknown) => {
  if (!trustedAppFrame(event) || !validAttemptId(attemptId)) return;
  startWatcher(attemptId);
});

ipcMain.on('stop-watcher', (event) => {
  if (!trustedAppFrame(event)) return;
  stopWatcher();
});

ipcMain.handle('get-display-count', (event) => {
  if (!trustedAppFrame(event)) throw new Error('Untrusted application request.');
  return getDisplayCount();
});
ipcMain.handle('get-environment-risk', (event) => {
  if (!trustedAppFrame(event)) throw new Error('Untrusted application request.');
  return getEnvironmentRisk();
});
ipcMain.handle('get-foreground-app', (event) => {
  if (!trustedAppFrame(event)) throw new Error('Untrusted application request.');
  return getForegroundApp();
});

async function startLocalServer(): Promise<boolean> {
  if (useDevServers) return true;
  runtime = await startRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: path.join(__dirname, '../../..'),
    userDataPath: app.getPath('userData'),
    judgeBuild,
    forkUtility: (entry, options) =>
      utilityProcess.fork(entry, [], {
        cwd: options.cwd,
        env: options.env,
        stdio: 'pipe',
        serviceName: 'Exam Anti-Cheat server',
      }),
    forkNode: (entry, options) => nodeChildProcess(entry, options),
    isPortFree: checkPortFree,
    canConnect: checkCanConnect,
    showError: async (title, message) => {
      await dialog.showMessageBox({ type: 'error', title, message, buttons: ['Quit'] });
    },
    log: (line) => diagnostic('server-runtime', line),
  });
  return runtime !== null;
}

export async function startApp(): Promise<void> {
  // Test-only: lets the unpackaged dev build behave like the judge build (demo mode + seeding).
  // Ignored in packaged apps, so it cannot change an installed build.
  judgeBuild =
    readJudgeBuild(app.getAppPath(), app.isPackaged) ||
    (!app.isPackaged && process.env.EAC_TEST_JUDGE_BUILD === '1');
  runMode = readRunMode(app.getPath('userData'), defaultRunMode(judgeBuild));
  if (!(await startLocalServer())) {
    app.quit();
    return;
  }
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
    await systemPreferences.askForMediaAccess('microphone');
  }
  await createWindow();
}

export function reportStartupFailure(error: unknown): void {
  diagnostic('startup-failed', error instanceof Error ? error.name : 'unknown');
  try {
    dialog.showErrorBox(
      'Exam Anti-Cheat could not start',
      'The application failed to start. Diagnostics were written to the logs folder. The application will now quit.',
    );
  } catch {
    /* Quit regardless. */
  }
  app.quit();
}

void app.whenReady().then(startApp).catch(reportStartupFailure);

let stoppingRuntime = false;
app.on('before-quit', (event) => {
  if (!runtime || stoppingRuntime) return;
  stoppingRuntime = true;
  event.preventDefault();
  void runtime.stop().finally(() => {
    runtime = null;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});
