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
    input: [],
    voice: [],
    liveness: [],
    transcripts: [],
    revisions: [],
    phones: [],
    audits: [],
    evidence: [],
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
          {
            created_at: '2026-09-15T00:08:00.000Z',
            foreground_app: 'flag:lighting_poor_backlit',
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
    expect(by('lighting_poor')).toMatchObject({ source: 'camera', severity: 'info' });
    expect(by('lighting_poor')?.summary).toContain('backlit');
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

  it('never dates a keystroke summary before the attempt started', () => {
    const entries = buildTimeline(
      rows({
        meta: { ...meta, startedAt: '2026-09-15T00:00:30.000Z' },
        keystrokes: [
          {
            created_at: '2026-09-15T00:00:45.000Z',
            question_version_id: 'q',
            dwell_ms: 80,
            flight_ms: 100,
          },
        ],
      }),
    );
    const typing = entries.find((e) => e.kind === 'typing_rhythm')!;
    expect(typing.at).toBe('2026-09-15T00:00:30.000Z');
    expect(typing.summary).toContain('Typed 1 keystroke (');
    expect(entries[0]?.kind).toBe('attempt_started');
  });

  it('uses singular wording for a count of one', () => {
    const entries = buildTimeline(
      rows({
        revisions: [
          { created_at: '2026-09-15T00:08:00.000Z', question_version_id: 'q1', word_count: 1 },
        ],
      }),
    );
    expect(entries.find((e) => e.kind === 'answer_saved')?.summary).toBe('Answer saved (1 word)');
  });

  it('maps evidence snapshots to non-accusatory notices carrying only ids', () => {
    const entries = buildTimeline(
      rows({
        evidence: [
          {
            id: 'e1',
            source: 'webcam',
            trigger: 'multiple_faces',
            captured_at: '2026-09-15T00:02:00.000Z',
          },
          {
            id: 'e2',
            source: 'screen',
            trigger: 'overlay_detected',
            captured_at: '2026-09-15T00:03:00.000Z',
          },
          {
            id: 'e3',
            source: 'desk_camera',
            trigger: 'left_frame',
            captured_at: '2026-09-15T00:04:00.000Z',
          },
          { id: 'e4', source: 'webcam', trigger: 'look_away', captured_at: 'not a date' },
        ],
      }),
    );
    const photos = entries.filter((e) => e.kind === 'evidence_snapshot');
    expect(photos.map((e) => [e.source, e.severity])).toEqual([
      ['camera', 'notice'],
      ['desktop', 'notice'],
      ['phone', 'notice'],
    ]);
    expect(photos[0]).toMatchObject({
      summary: 'Photo saved: another person in view',
      data: { evidenceId: 'e1', trigger: 'multiple_faces', source: 'webcam' },
    });
    expect(photos[2]?.summary).toBe('Photo saved: nobody in view of the desk camera');
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
    ).toEqual({ keystrokes: 0, gaze: 2, voice: 0, input: 0 });
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

  it('lists stored evidence snapshots in the log without their image bytes', () => {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DROP TRIGGER published_assignment_only;');
    db.exec(`
      INSERT INTO exam_assignments (id, exam_version_id, student_id, assigned_at)
        VALUES ('as1', 'v1', 'u1', '2026-09-15T00:00:00.000Z');
      INSERT INTO exam_attempts (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
        VALUES ('a1', 'as1', 'in_progress', 's', '2026-09-15T00:00:00.000Z', '2026-09-15T01:00:00.000Z', '2026-09-15T01:00:00.000Z');
    `);
    const id = service.recordEvidence({
      attemptId: 'a1',
      source: 'webcam',
      trigger: 'no_face',
      capturedAt: new Date('2026-09-15T00:05:00.000Z'),
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      now: new Date('2026-09-15T00:05:01.000Z'),
    });
    const log = service.getTimeline('a1', new Set(['camera']));
    expect(log).toEqual([
      {
        at: '2026-09-15T00:05:00.000Z',
        source: 'camera',
        kind: 'evidence_snapshot',
        severity: 'notice',
        summary: 'Photo saved: no face in view',
        data: { evidenceId: id, trigger: 'no_face', source: 'webcam' },
      },
    ]);
  });
});

const inputWindow = {
  window_start: '2026-09-15T00:02:00.000Z',
  window_ms: 20_000,
  pointer_events: 40,
  pointer_leaves: 2,
  pointer_outside_ms: 12_000,
  longest_outside_ms: 9_000,
  outside_edge: 'right',
  untrusted_events: 0,
  teleports: 0,
  robotic_segments: 0,
  path_straightness: 0.6,
  velocity_cv: 0.8,
  context_menus: 0,
  selections: 0,
  keys: 0,
  chars: 0,
  corrections: 0,
  mean_dwell_ms: null,
  mean_interval_ms: null,
  interval_cv: null,
  wpm: null,
  injections: 0,
  idle_pointer_injections: 0,
  drift_z_dwell: null,
  drift_z_interval: null,
};

describe('input behaviour in the timeline', () => {
  it('lists pointer excursions and an injection with a still pointer, but not quiet windows', () => {
    const entries = buildTimeline(
      rows({
        input: [
          inputWindow,
          { ...inputWindow, window_start: '2026-09-15T00:03:00.000Z', pointer_outside_ms: 500 },
          {
            ...inputWindow,
            window_start: '2026-09-15T00:04:00.000Z',
            pointer_outside_ms: 0,
            injections: 1,
            idle_pointer_injections: 1,
          },
        ],
      }),
    ).filter((e) => e.source === 'pointer' || e.kind === 'injection_idle_pointer');
    expect(entries.map((e) => [e.kind, e.source, e.severity])).toEqual([
      ['pointer_outside', 'pointer', 'info'],
      ['injection_idle_pointer', 'keyboard', 'flag'],
    ]);
    expect(entries[0]!.summary).toBe('Pointer outside the exam window for 12 s (2 times)');
    expect(entries[0]!.data).toEqual({
      leaves: 2,
      outsideMs: 12_000,
      longestMs: 9_000,
      edge: 'right',
    });
  });

  it('maps input events from the events path to pointer and keyboard entries', () => {
    const app = (name: string) => ({
      created_at: '2026-09-15T00:05:00.000Z',
      foreground_app: `flag:${name}`,
      display_count: 1,
    });
    const entries = buildTimeline(
      rows({
        apps: [
          app('pointer_outside_long'),
          app('synthetic_input'),
          app('text_injected'),
          app('uniform_typing'),
          app('burst_after_idle'),
          app('typing_drift'),
          app('drop_blocked'),
          app('copy_question'),
        ],
      }),
    ).filter((e) => e.kind !== 'attempt_started' && e.kind !== 'attempt_submitted');
    expect(entries.map((e) => `${e.source}:${e.kind}`)).toEqual([
      'pointer:pointer_outside_long',
      'pointer:synthetic_input',
      'keyboard:text_injected',
      'keyboard:uniform_typing',
      'keyboard:burst_after_idle',
      'keyboard:typing_drift',
      'browser:drop_blocked',
      'browser:copy_question',
    ]);
    expect(entries[2]!.summary).toBe('Long answer appeared at once (possible paste tool)');
  });
});

describe('input behaviour persistence', () => {
  let db!: DatabaseSync;
  let service!: IntegrityService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DROP TRIGGER published_assignment_only;');
    db.exec(`
      INSERT INTO users (id, email, password_hash, role, created_at)
        VALUES ('u1', 's@example.test', 'x', 'student', '2026-09-01T00:00:00.000Z');
      INSERT INTO exam_assignments (id, exam_version_id, student_id, assigned_at)
        VALUES ('as1', 'v1', 'u1', '2026-09-15T00:00:00.000Z');
      INSERT INTO exam_attempts (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
        VALUES ('a1', 'as1', 'in_progress', 's', '2026-09-15T00:00:00.000Z', '2026-09-15T01:00:00.000Z', '2026-09-15T01:00:00.000Z');
    `);
    service = new IntegrityService(new IntegrityRepository(db), null);
  });
  afterEach(() => db.close());

  it('stores validated windows, drops unusable ones and clamps wild numbers', () => {
    const counts = service.recordTelemetry('a1', {
      input: [
        {
          windowStart: Date.parse('2026-09-15T00:02:00.000Z'),
          windowMs: 20_000,
          pointerEvents: 12,
          pointerLeaves: 1,
          pointerOutsideMs: 99_999_999,
          longestOutsideMs: 6_000,
          outsideEdge: 'diagonal',
          pathStraightness: 5,
          wpm: 80.4,
          injections: 1,
          idlePointerInjections: 1,
        },
        { windowStart: 'not a time', windowMs: 20_000 },
        { windowStart: Date.now(), windowMs: 0 },
        'junk',
      ],
    });
    expect(counts.input).toBe(1);
    const row = db.prepare('SELECT * FROM input_behaviour_windows').get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      attempt_id: 'a1',
      window_start: '2026-09-15T00:02:00.000Z',
      window_ms: 20_000,
      pointer_outside_ms: 20_000,
      outside_edge: null,
      path_straightness: null,
      wpm: 80.4,
      injections: 1,
    });
  });

  it('surfaces stored windows in the log under the pointer source', () => {
    service.recordTelemetry('a1', {
      input: [
        {
          windowStart: Date.parse('2026-09-15T00:02:00.000Z'),
          windowMs: 20_000,
          pointerLeaves: 1,
          pointerOutsideMs: 12_000,
          longestOutsideMs: 12_000,
          outsideEdge: 'left',
        },
      ],
    });
    const log = service.getTimeline('a1', new Set(['pointer']));
    expect(log?.map((e) => e.summary)).toEqual(['Pointer outside the exam window for 12 s']);
  });
});
