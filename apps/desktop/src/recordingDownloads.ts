import { mkdirSync } from 'fs';
import * as path from 'path';

/** Folder for screen-recording segments the exam saves on this Mac (no upload). */
export function recordingFolder(moviesDir: string): string {
  return path.join(moviesDir, 'ExamGuard Recordings');
}

/** Only the exam's own recording segments may be saved; the name is reduced to a safe basename. */
export function recordingSavePath(moviesDir: string, filename: string): string | null {
  const base = path.basename(filename);
  if (!/^[\w.-]{1,120}\.webm$/u.test(base)) return null;
  return path.join(recordingFolder(moviesDir), base);
}

interface DownloadItemLike {
  getFilename(): string;
  setSavePath(path: string): void;
  cancel(): void;
}

/**
 * Saves recording segments silently into ~/Movies/ExamGuard Recordings (no "Save As" dialog during
 * the exam) and cancels any other download the exam page might start.
 */
export function registerRecordingDownloads(deps: {
  readonly session: {
    on?(event: 'will-download', listener: (event: unknown, item: DownloadItemLike) => void): void;
  };
  readonly moviesDir: string;
  readonly log?: (message: string) => void;
}): void {
  if (typeof deps.session.on !== 'function') return;
  deps.session.on('will-download', (_event, item) => {
    const target = recordingSavePath(deps.moviesDir, item.getFilename());
    if (target === null) {
      item.cancel();
      deps.log?.(`download-blocked ${path.basename(item.getFilename())}`);
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    item.setSavePath(target);
  });
}
