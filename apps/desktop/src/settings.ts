import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { parseRunMode, type RunMode } from './mode';

export const SETTINGS_FILE = 'settings.json';

export function readRunMode(dir: string): RunMode {
  try {
    return parseRunMode(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'));
  } catch {
    return parseRunMode(undefined);
  }
}

export function writeRunMode(dir: string, mode: RunMode): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE);
  writeFileSync(file, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // The create-mode is ignored if the file already existed.
}
