import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../db/client.js';
import { IntegrityRepository, type TimelineRows } from './integrityRepository.js';
import { IntegrityService } from './integrityService.js';
import { buildTimeline, csvCell, timelineToCsv } from './timeline.js';

const meta = {
  id: 'a1',
  status: 'submitted',
  startedAt: '2026-09-15T00:00:00.000Z',
  submittedAt: '2026-09-15T00:10:00.000Z',
  expiredAt: null,
  studentId: 'u1',
};

function rows(overrides: Partial<TimelineRows> = {}): TimelineRows {
  return {
    meta,
    gaze: [],
    apps: [],
    keystrokes: [],
    voice: [],
    liveness: [],
    transcripts: [],
    revisions: [],
    phones: [],
    audits: [],
    ...overrides,
  };
}

describe('buildTimeline', () => {
  it('merges every signal into one list sorted by time, stable for ties', () => {
    const entries = buildTimeline(
      rows({
        gaze: [
          {
            off_screen_start: '2026-09-15T00:03:00.000Z',
            duration_ms: 7000,
            direction: 'left',
            yaw: -30,
            pitch: 2,
          },
        ],
        apps: [
          {
            created_at: '2026-09-15T00:01:00.000Z',
            foreground_app: 'flag:focus_lost',
            display_count: 1,
          },
          { created_at: '2026-09-15T00:05:00.000Z', foreground_app: 'Notes', display_count: 1 },
          { created_at: '2026-09-15T00:06:00.000Z', foreground_app: 'Exam', display_count: 2 },
          { created_at: '2026-09-15T00:07:00.000Z', foreground_app: 'unknown', display_count: 1 },
        ],
        voice: [{ detected_at: '2026-09-15T00:02:00.000Z', duration_ms: 1500, peak_db: -20.123 }],
        transcripts: [{ captured_at: '2026-09-15T00:02:30.000Z', text: 'hello there' }],
        liveness: [
          {
            created_at: '2026-09-15T00:04:00.000Z',
            layer: 3,
            result: 'fail',
            details_json: '{"detail":"Head turn not seen","phone":"observed"}',
          },
        ],
        revisions: [
          { created_at: '2026-09-15T00:08:00.000Z', question_version_id: 'q1', word_count: 5 },
          { created_at: '2026-09-15T00:09:00.000Z', question_version_id: 'q1', word_count: 80 },
        ],
        audits: [{ occurred_at: '2026-09-15T00:00:30.000Z', action: 'auth.logged_in' }],
      }),
    );

    const times = entries.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(entries.map((e) => e.kind)).toEqual([
      'attempt_started',
      'auth.logged_in',
      'focus_lost',
      'voice_activity',
      'transcript',
      'gaze_left',
      'liveness_fail',
      'foreground_app',
      'multiple_displays',
      'answer_saved',
      'answer_large_addition',
      'attempt_submitted',
    ]);
    expect(entries.find((e) => e.kind === 'gaze_left')).toMatchObject({
      source: 'gaze',
      severity: 'notice',
      data: { durationMs: 7000, yaw: -30 },
    });
    expect(entries.find((e) => e.kind === 'liveness_fail')).toMatchObject({
      severity: 'flag',
      data: { phone: 'observed', detail: 'Head turn not seen' },
    });
    // Answer text never leaks into the log.
    expect(JSON.stringify(entries)).not.toContain('value_text');
  });

  it('normalizes missing faces, multiple faces, unknown directions and bad timestamps', () => {
    const entries = buildTimeline(
      rows({
        gaze: [
          {
            off_screen_start: '2026-09-15T00:01:00.000Z',
            duration_ms: 12000,
            direction: 'no_face',
            yaw: null,
            pitch: null,
          },
          {
            off_screen_start: '2026-09-15T00:02:00.000Z',
            duration_ms: 6000,
            direction: 'multiple_faces',
            yaw: null,
            pitch: null,
          },
          {
            off_screen_start: '2026-09-15T00:03:00.000Z',
            duration_ms: 20000,
            direction: 'away',
            yaw: null,
            pitch: null,
          },
          {
            off_screen_start: 'not a date',
            duration_ms: 1000,
            direction: 'left',
            yaw: null,
            pitch: null,
          },
        ],
        apps: [
          {
            created_at: '2026-09-15T00:04:00.000Z',
            foreground_app: 'flag:vision_cell_phone',
            display_count: 1,
          },
          {
            created_at: '2026-09-15T00:05:00.000Z',
            foreground_app: 'flag:desk_camera_extra_person',
            display_count: 1,
          },
          {
            created_at: '2026-09-15T00:06:00.000Z',
            foreground_app: 'flag:camera_swapped_to_virtual',
            display_count: 1,
          },
          {
            created_at: '2026-09-15T00:07:00.000Z',
            foreground_app: 'flag:something_new',
            display_count: 1,
          },
        ],
      }),
    );
    expect(entries.filter((e) => e.kind === 'gaze_left')).toHaveLength(0);
    const by = (kind: string) => entries.find((e) => e.kind === kind);
    expect(by('face_missing')).toMatchObject({ source: 'camera', severity: 'notice' });
    expect(by('multiple_faces')).toMatchObject({ source: 'camera', severity: 'flag' });
    expect(by('gaze_away')).toMatchObject({ source: 'gaze', severity: 'flag' });
    expect(by('vision_object')?.summary).toContain('cell phone');
    expect(by('desk_extra_person')?.source).toBe('phone');
    expect(by('camera_virtual')?.severity).toBe('flag');
    expect(by('flag')).toMatchObject({ source: 'system', summary: 'Recorded: something new' });
  });

  it('summarises keystrokes per minute instead of one row each', () => {
    const entries = buildTimeline(
      rows({
        keystrokes: [
          {
            created_at: '2026-09-15T00:01:05.000Z',
            question_version_id: 'q',
            dwell_ms: 80,
            flight_ms: 100,
          },
          {
            created_at: '2026-09-15T00:01:40.000Z',
            question_version_id: 'q',
            dwell_ms: 100,
            flight_ms: 140,
          },
          {
            created_at: '2026-09-15T00:02:10.000Z',
            question_version_id: 'q',
            dwell_ms: 90,
            flight_ms: 120,
          },
        ],
      }),
    );
    const typing = entries.filter((e) => e.kind === 'typing_rhythm');
    expect(typing.map((e) => e.at)).toEqual([
      '2026-09-15T00:01:00.000Z',
      '2026-09-15T00:02:00.000Z',
    ]);
    expect(typing[0]?.data).toEqual({ keystrokes: 2, medianDwellMs: 90, medianFlightMs: 120 });
  });
});

describe('CSV export', () => {
  it('quotes commas, quotes and newlines and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });

  it('writes a header and CRLF-terminated rows with data as JSON', () => {
    const csv = timelineToCsv([
      {
        at: '2026-09-15T00:00:00.000Z',
        source: 'gaze',
        kind: 'gaze_left',
        severity: 'info',
        summary: 'Head turned to the left for 3 s',
        data: { durationMs: 3000 },
      },
    ]);
    expect(csv).toBe(
      'at,source,kind,severity,summary,data\r\n' +
        '2026-09-15T00:00:00.000Z,gaze,gaze_left,info,Head turned to the left for 3 s,"{""durationMs"":3000}"\r\n',
    );
  });
});

describe('IntegrityService.getTimeline over a real database', () => {
  let db!: DatabaseSync;
  let service!: IntegrityService;
  let repo!: IntegrityRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.exec(`
      INSERT INTO users (id, email, password_hash, role, created_at)
        VALUES ('u1', 's@example.test', 'x', 'student', '2026-09-01T00:00:00.000Z');
    `);
    repo = new IntegrityRepository(db);
    service = new IntegrityService(repo, null);
  });
  afterEach(() => db.close());

  it('returns null for an unknown attempt', () => {
    expect(service.getTimeline('nope')).toBeNull();
  });

  it('stores gaze direction from telemetry and drops unknown directions to "away"', () => {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DROP TRIGGER published_assignment_only;');
    db.exec(`
      INSERT INTO exam_assignments (id, exam_version_id, student_id, assigned_at)
        VALUES ('as1', 'v1', 'u1', '2026-09-15T00:00:00.000Z');
      INSERT INTO exam_attempts (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
        VALUES ('a1', 'as1', 'in_progress', 's', '2026-09-15T00:00:00.000Z', '2026-09-15T01:00:00.000Z', '2026-09-15T01:00:00.000Z');
    `);
    expect(
      service.recordTelemetry('a1', {
        gaze: [
          {
            timestamp: '2026-09-15T00:01:00.000Z',
            durationMs: 4000,
            direction: 'down',
            yaw: 1.4,
            pitch: 33.6,
          },
          { timestamp: '2026-09-15T00:02:00.000Z', durationMs: 3000, direction: 'ceiling' },
        ],
      }),
    ).toEqual({ keystrokes: 0, gaze: 2, voice: 0 });
    const rows = db
      .prepare('SELECT direction, yaw, pitch FROM gaze_events ORDER BY off_screen_start')
      .all();
    expect(rows).toEqual([
      { direction: 'down', yaw: 1, pitch: 34 },
      { direction: 'away', yaw: null, pitch: null },
    ]);
    const log = service.getTimeline('a1', new Set(['gaze']));
    expect(log?.map((e) => e.kind)).toEqual(['gaze_down', 'gaze_away']);
  });
});
