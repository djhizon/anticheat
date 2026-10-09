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

/**
 * A settings file is user-writable, so it may only ever change the mode of the judge build (whose
 * default is Demo anyway). Every other build is Strict at each start: a hand-edited
 * `{"mode":"demo"}` must not silently disable the exam checks. An in-app switch to Demo in such a
 * build lasts for that session only (see `persistRunMode`).
 */
export function readRunMode(dir: string, fallback: RunMode, judgeBuild = false): RunMode {
  if (!judgeBuild) return 'strict';
  try {
    return parseRunMode(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

/** Only the judge build persists the chosen mode; other builds start Strict every time. */
export function persistRunMode(judgeBuild: boolean): boolean {
  return judgeBuild;
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
