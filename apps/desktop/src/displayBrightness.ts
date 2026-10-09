import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  createBrightnessController,
  type BrightnessHelper,
  type BrightnessReading,
  type OriginalStore,
} from './brightness';
import type { RunMode } from './mode';

const UNSUPPORTED: BrightnessReading = { supported: false, brightness: null };

/** Native helper client: fixed executable, JSON on stdin, JSON reply. Never a shell. */
export function createBrightnessHelper(executable: string): BrightnessHelper {
  const call = (action: 'brightness-get' | 'brightness-set', level?: number) =>
    new Promise<BrightnessReading>((resolve) => {
      const child = execFile(
        executable,
        [],
        { timeout: 4000, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) return resolve(UNSUPPORTED);
          try {
            const reply = JSON.parse(stdout) as { supported?: unknown; brightness?: unknown };
            const value = reply.brightness;
            resolve(
              reply.supported === true &&
                typeof value === 'number' &&
                Number.isFinite(value) &&
                value >= 0 &&
                value <= 1
                ? { supported: true, brightness: value }
                : UNSUPPORTED,
            );
          } catch {
            resolve(UNSUPPORTED);
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(
        JSON.stringify({
          action,
          ...(level === undefined ? {} : { level }),
          hostPid: process.pid,
          hostExecutable: process.execPath,
        }),
      );
    });
  return { get: () => call('brightness-get'), set: (level) => call('brightness-set', level) };
}

/** The pre-exam level lives in userData so a crash can be undone on the next launch. */
export function createOriginalStore(userDataPath: string): OriginalStore {
  const file = path.join(userDataPath, 'display-brightness.json');
  return {
    read() {
      try {
        const value = (JSON.parse(fs.readFileSync(file, 'utf8')) as { original?: unknown })
          .original;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
          ? value
          : null;
      } catch {
        return null;
      }
    },
    write(level) {
      fs.writeFileSync(file, JSON.stringify({ original: level, at: new Date().toISOString() }));
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

interface FrameEvent {
  sender: unknown;
  senderFrame?: { url: string } | null;
}

export interface DisplayBrightnessOptions {
  ipcMain: {
    handle(channel: string, handler: (event: never, ...args: unknown[]) => unknown): void;
  };
  app: {
    isPackaged: boolean;
    whenReady(): Promise<unknown>;
    on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
    quit(): void;
    getPath(name: 'userData'): string;
  };
  resourcesPath: string;
  appDir: string;
  getMode: () => RunMode;
  trustedAppFrame: (event: FrameEvent) => boolean;
  validAttemptId: (value: unknown) => value is string;
  /** Delivers `brightness_restored` to the renderer, which posts it to the unified timeline. */
  notifyRestored: (attemptId: string) => void;
  log: (event: string, detail?: string) => void;
}

/**
 * Wires the narrow `display:boost-brightness` / `display:restore-brightness` IPC, restores the
 * original level before the app quits, and undoes a previous crash on launch.
 */
export function registerDisplayBrightness(options: DisplayBrightnessOptions) {
  const { app } = options;
  const executable = app.isPackaged
    ? path.join(options.resourcesPath, 'app-control')
    : path.join(options.appDir, '../native-bin/app-control');
  const controller = createBrightnessController({
    helper: createBrightnessHelper(executable),
    store: createOriginalStore(app.getPath('userData')),
    getMode: options.getMode,
    onRestored: options.notifyRestored,
    log: options.log,
  });

  options.ipcMain.handle('display:boost-brightness', (event: never, attemptId: unknown) => {
    if (!options.trustedAppFrame(event as FrameEvent) || !options.validAttemptId(attemptId))
      throw new Error('Untrusted application request.');
    return controller.boost(attemptId);
  });
  options.ipcMain.handle('display:restore-brightness', async (event: never) => {
    if (!options.trustedAppFrame(event as FrameEvent))
      throw new Error('Untrusted application request.');
    await controller.restore();
    return { status: 'restored' };
  });

  // Registered before the runtime-stop handler in main.ts, so the level is back before quitting.
  app.on('before-quit', (event) => {
    if (!controller.isActive()) return;
    event.preventDefault();
    void controller.restore().finally(() => app.quit());
  });
  void app
    .whenReady()
    .then(() => controller.recover())
    .catch(() => {});

  return { restore: () => controller.restore(), isActive: () => controller.isActive() };
}
