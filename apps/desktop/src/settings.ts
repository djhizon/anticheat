import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';
import { isJudgeBuildMetadata, parseRunMode, type RunMode } from './mode';

export const SETTINGS_FILE = 'settings.json';

/** Reads the build-time judge flag baked into the packaged app's package.json (`extraMetadata`). */
export function readJudgeBuild(appPath: string, isPackaged: boolean): boolean {
  if (!isPackaged) return false;
  try {
    return isJudgeBuildMetadata(readFileSync(path.join(appPath, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
}

export function readRunMode(dir: string, fallback: RunMode): RunMode {
  try {
    return parseRunMode(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file (0600) in the same directory, then rename over the target. */
export function writeRunMode(dir: string, mode: RunMode): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE);
  const temp = path.join(dir, `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* Temp file may not exist. */
    }
    throw error;
  }
}
