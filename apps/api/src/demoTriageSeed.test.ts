import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedDemo } from './demoSeed.js';
import { syntheticJpeg, triageStudents } from './demoTriageSeed.js';

const directories: string[] = [];
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'eac-triage-seed-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('syntheticJpeg', () => {
  it('writes a baseline JPEG with SOI, SOF0, DHT, SOS and EOI markers', () => {
    const bytes = syntheticJpeg(140);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(bytes.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xff, 0xda]))).toBe(true);
    expect(bytes.length).toBeLessThan(400);
    if (process.env.TRIAGE_JPEG_OUT) writeFileSync(process.env.TRIAGE_JPEG_OUT, bytes);
  });
});

describe('seedTriageStudents (through seedDemo)', () => {
  it('adds submitted attempts with synthetic timelines and is idempotent', async () => {
    const databasePath = join(tempDir(), 'seed.sqlite');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const env = { DATABASE_PATH: databasePath, GEMINI_API_KEYS: '' };
      await seedDemo({ env });
      await seedDemo({ env });
    } finally {
      log.mockRestore();
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT u.email AS email, t.id AS id, t.status AS status, t.started_at AS started_at,
                  t.submitted_at AS submitted_at,
                  (SELECT COUNT(*) FROM gaze_events g WHERE g.attempt_id = t.id) AS gaze,
                  (SELECT COUNT(*) FROM evidence_snapshots e WHERE e.attempt_id = t.id) AS photos,
                  (SELECT COUNT(*) FROM audio_transcripts a WHERE a.attempt_id = t.id) AS lines
             FROM exam_attempts t
             JOIN exam_assignments a ON a.id = t.assignment_id
             JOIN users u ON u.id = a.student_id
            WHERE u.email LIKE 'triage.%' ORDER BY u.email`,
        )
        .all() as Array<Record<string, string | number>>;
      expect(rows.map((row) => row.email)).toEqual(
        [...triageStudents].map((entry) => entry.email).sort(),
      );
      for (const row of rows) {
        expect(row.status).toBe('submitted');
        expect(Number(row.gaze)).toBeGreaterThan(0);
        // Every synthetic event lies inside the attempt's 35-minute span.
        const span = Date.parse(String(row.submitted_at)) - Date.parse(String(row.started_at));
        expect(span).toBeGreaterThan(30 * 60_000);
      }
      const review = rows.find((row) => row.email === 'triage.review@example.test');
      expect(Number(review?.photos)).toBeGreaterThanOrEqual(3);
      expect(Number(review?.lines)).toBe(2);
      const clean = rows.find((row) => row.email === 'triage.clean@example.test');
      expect(Number(clean?.photos)).toBe(0);
      // One attempt per triage student even after re-running the seed.
      expect(rows).toHaveLength(triageStudents.length);
    } finally {
      db.close();
    }
  });
});
