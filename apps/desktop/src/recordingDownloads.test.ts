import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { recordingSavePath, registerRecordingDownloads } from './recordingDownloads';

describe('recording downloads', () => {
  it('maps recording segments into the ExamGuard Recordings folder', () => {
    expect(recordingSavePath('/Users/x/Movies', 'exam-demo-abc-1.webm')).toBe(
      '/Users/x/Movies/ExamGuard Recordings/exam-demo-abc-1.webm',
    );
  });

  it('rejects other files and path tricks', () => {
    expect(recordingSavePath('/m', 'notes.pdf')).toBeNull();
    expect(recordingSavePath('/m', '../../evil.webm')).toBe('/m/ExamGuard Recordings/evil.webm');
    expect(recordingSavePath('/m', 'a b.webm')).toBeNull();
  });

  it('saves silently or cancels', () => {
    const movies = mkdtempSync(path.join(tmpdir(), 'eg-movies-'));
    let listener: ((e: unknown, item: never) => void) | undefined;
    registerRecordingDownloads({
      session: { on: (_e, l) => (listener = l as never) },
      moviesDir: movies,
    });
    const ok = { getFilename: () => 'exam-demo-s-2.webm', setSavePath: vi.fn(), cancel: vi.fn() };
    listener!(null, ok as never);
    expect(ok.setSavePath).toHaveBeenCalledWith(
      path.join(movies, 'ExamGuard Recordings', 'exam-demo-s-2.webm'),
    );
    expect(existsSync(path.join(movies, 'ExamGuard Recordings'))).toBe(true);
    const bad = { getFilename: () => 'x.exe', setSavePath: vi.fn(), cancel: vi.fn() };
    listener!(null, bad as never);
    expect(bad.cancel).toHaveBeenCalled();
    expect(bad.setSavePath).not.toHaveBeenCalled();
  });
});
