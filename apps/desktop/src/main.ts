
import { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut, session, systemPreferences, dialog, desktopCapturer } from 'electron';

import { execSync } from 'child_process';
import * as path from 'path';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { createAppController, createHelperCall } from './appControl';

const WEB_URL = 'http://127.0.0.1:5173/';
const APP_WATCH_INTERVAL_MS = 2000;

let mainWindow: BrowserWindow | null = null;
let watcherInterval: ReturnType<typeof setInterval> | null = null;
let appController: ReturnType<typeof createAppController> | null = null;

function trustedAppFrame(event: Electron.IpcMainInvokeEvent): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame?.url === WEB_URL;
}

// Store only fixed lifecycle categories/codes, never URLs, answers, credentials,
// console output or application names. Bound the local diagnostic file size.
function diagnostic(event: string, detail: string | number = ''): void {
  try {
    const file = path.join(app.getPath('userData'), 'desktop-health.log');
    if (existsSync(file) && statSync(file).size > 65536) writeFileSync(file, '');
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`);
  } catch { /* Diagnostics must never prevent the recovery UI. */ }
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

function startWatcher(attemptId: string): void {
  if (watcherInterval) clearInterval(watcherInterval);
  watcherInterval = setInterval(() => {
    const app = getForegroundApp();
    const displays = getDisplayCount();
    // Hand the snapshot to the renderer, which posts it with the student's
    // session cookie and CSRF token. The main process holds no credentials.
    mainWindow?.webContents.send('app-snapshot', { attemptId, foregroundApp: app, displayCount: displays });
  }, APP_WATCH_INTERVAL_MS);
}

function stopWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.on('renderer-failure', event => {
  if (event.sender === mainWindow?.webContents) diagnostic('renderer-javascript-error');
});

ipcMain.handle('list-app-targets', event => {
  if (!trustedAppFrame(event) || !appController) throw new Error('Untrusted application request.');
  return appController.list();
});
ipcMain.handle('close-app-target', (event, request: unknown) => {
  if (!trustedAppFrame(event) || !appController || !request || typeof request !== 'object') throw new Error('Untrusted application request.');
  const input = request as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'id,mode') throw new Error('Invalid application request.');
  return appController.close(input.id, input.mode);
});

// Older renderer/preload copies may still send this message. Refuse it without
// inspecting or signalling processes: display names are not safe PID identities.
ipcMain.handle('kill-app', () => false);

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

  // Keep an OS-owned exit available even when the renderer crashes.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Exam Anti-Cheat', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [
      { label: 'Reload application', accelerator: 'CmdOrCtrl+R', click: () => { void mainWindow?.loadURL(WEB_URL).catch(() => {}); } },
      { role: 'toggleDevTools' }, { role: 'minimize' }, { role: 'close' },
    ] },
  ]));

  const window = mainWindow;
  let navigationGeneration = 0;
  appController = createAppController({
    call: createHelperCall(app.isPackaged
      ? path.join(process.resourcesPath, 'app-control')
      : path.join(__dirname, '../native-bin/app-control')),
    confirm: async (name, mode) => {
      if (window.isDestroyed()) return false;
      const response = await dialog.showMessageBox(window, {
        type: 'warning', title: mode === 'quit' ? 'Quit application?' : 'Force Quit application?',
        message: `${mode === 'quit' ? 'Request a normal quit of' : 'Force Quit'} ${name}?`,
        detail: mode === 'quit' ? 'Save your work first. The app may ask you to save or cancel.'
          : 'Unsaved work may be permanently lost. This closes the app without a normal save prompt.',
        buttons: ['Cancel', mode === 'quit' ? 'Quit normally' : 'Force Quit'], defaultId: 0, cancelId: 0,
        noLink: true,
      });
      return response.response === 1 && !window.isDestroyed();
    },
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { navigationGeneration++; appController?.reset(); }
  });
  let showingRecovery = false;
  const recover = async (reason: string): Promise<void> => {
    if (showingRecovery || window.isDestroyed()) return;
    showingRecovery = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'error', title: 'Exam window needs recovery',
        message: reason,
        detail: 'No exam data has been reset. Check that the local servers are running. You can reload or close the application.',
        buttons: ['Reload', 'Close'], defaultId: 0, cancelId: 1,
      });
      if (window.isDestroyed()) return;
      // Release before navigating: a failed retry must be allowed to display
      // another recovery dialog instead of being discarded as a duplicate.
      showingRecovery = false;
      if (result.response === 0) void window.loadURL(WEB_URL).catch(() => {
        void recover('The exam page still could not be loaded.');
      });
      else window.destroy();
    } catch {
      diagnostic('recovery-dialog-failed');
      // If even the native dialog fails, close this unusable window rather
      // than leave a blank renderer. Saved exam data is untouched.
      if (!window.isDestroyed()) window.destroy();
    } finally { showingRecovery = false; }
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
  // alone does not implement getDisplayMedia. Never silently choose a screen.
  let screenPickerOpen = false;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (screenPickerOpen) { callback({}); return; }
    screenPickerOpen = true;
    const generation = navigationGeneration;
    let settled = false;
    const finish = (streams: Electron.Streams) => {
      if (settled) return;
      settled = true;
      screenPickerOpen = false;
      try { callback(streams); } catch { /* Requesting frame may have closed. */ }
    };
    const trusted = () => !window.isDestroyed() && mainWindow === window &&
      generation === navigationGeneration && request.frame !== null &&
      request.frame === window.webContents.mainFrame && request.frame.url === WEB_URL &&
      request.securityOrigin === new URL(WEB_URL).origin &&
      request.userGesture && request.videoRequested && !request.audioRequested;
    void (async () => {
      try {
        if (!trusted()) return finish({});
        const sources = await desktopCapturer.getSources({
          types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
        });
        if (!trusted() || sources.length === 0) return finish({});
        const choice = await dialog.showMessageBox(window, {
          type: 'question', title: 'Local screen recording',
          message: 'Choose a screen to record on this Mac',
          detail: 'Everything visible on the selected screen may be recorded. Recording files stay local. The built-in microphone is requested separately. Cancel does not start capture.',
          buttons: ['Cancel', ...sources.map((source, index) => `Record screen ${index + 1}: ${source.name}`)],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        const selected = sources[choice.response - 1];
        if (!trusted() || !selected) return finish({});
        finish({ video: selected }); // No system/loopback audio.
      } catch { finish({}); }
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
ipcMain.handle('get-foreground-app', () => getForegroundApp());

app.whenReady().then(async () => {
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
