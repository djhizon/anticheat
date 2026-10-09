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
} from 'electron';

import { execSync } from 'child_process';
import * as path from 'path';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { createAppController, createHelperCall } from './appControl';
import { classifyDisplays, detectVirtualMachine } from './environment';
import { mayCloseApps, planModeSwitch, type RunMode } from './mode';
import { readRunMode, writeRunMode } from './settings';

const WEB_URL = 'http://127.0.0.1:5173/';
const APP_WATCH_INTERVAL_MS = 2000;

let mainWindow: BrowserWindow | null = null;
let watcherInterval: ReturnType<typeof setInterval> | null = null;
// Demo is the safe default; the persisted choice is loaded once the app is ready.
let runMode: RunMode = 'demo';
let appController: ReturnType<typeof createAppController> | null = null;

function trustedAppFrame(event: Electron.IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame?.url === WEB_URL
  );
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

function getForegroundApp(): string {
  try {
    const asn = execSync('lsappinfo front', { timeout: 1000 }).toString().trim();
    if (!asn) return 'unknown';
    const output = execSync(`lsappinfo info ${asn}`, { timeout: 1000 }).toString();
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
  watcherInterval = setInterval(() => {
    const app = getForegroundApp();
    const displays = getDisplayCount();
    // Hand the snapshot to the renderer, which posts it with the student's
    // session cookie and CSRF token. The main process holds no credentials.
    mainWindow?.webContents.send('app-snapshot', {
      attemptId,
      foregroundApp: app,
      displayCount: displays,
      captureDisplays: getCaptureDisplays(),
    });
  }, APP_WATCH_INTERVAL_MS);
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
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Switch to Strict mode?',
      message: 'Strict mode can ask other applications to quit.',
      detail:
        'The pre-flight check will block until other apps are closed. Save your work first. Demo mode never closes or blocks anything.',
      buttons: ['Cancel', 'Switch to Strict'],
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

  // Grant all permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Automatically approve camera, mic, and screen sharing
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(true);
    }
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

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
      request.frame.url === WEB_URL &&
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

ipcMain.on('start-watcher', (_event, attemptId: string) => {
  startWatcher(attemptId);
});

ipcMain.on('stop-watcher', () => {
  stopWatcher();
});

ipcMain.handle('get-display-count', () => getDisplayCount());
ipcMain.handle('get-environment-risk', () => getEnvironmentRisk());
ipcMain.handle('get-foreground-app', () => getForegroundApp());

app.whenReady().then(async () => {
  runMode = readRunMode(app.getPath('userData'));
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera');
    await systemPreferences.askForMediaAccess('microphone');
  }
  void createWindow();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});
