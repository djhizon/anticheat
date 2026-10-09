import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../db/client.js';
import { FINDING_THRESHOLDS, buildFindings, reviewLevel } from './findings.js';
import {
  IntegrityRepository,
  type InputWindowRow,
  type TimelineRows,
} from './integrityRepository.js';
import { FINDINGS_CACHE_MS, IntegrityService } from './integrityService.js';

const START = Date.parse('2026-09-15T00:00:00.000Z');
/** ISO time `sec` seconds into the attempt. */
const at = (sec: number): string => new Date(START + sec * 1000).toISOString();

const meta = {
  id: 'a1',
  status: 'submitted',
  startedAt: at(0),
  submittedAt: at(1800),
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

const flag = (sec: number, name: string, displayCount = 1) => ({
  created_at: at(sec),
  foreground_app: `flag:${name}`,
  display_count: displayCount,
});

const gaze = (
  sec: number,
  durationMs: number,
  direction: string,
  yaw: number | null = null,
  pitch: number | null = null,
) => ({ off_screen_start: at(sec), duration_ms: durationMs, direction, yaw, pitch });

function window(sec: number, overrides: Partial<InputWindowRow> = {}): InputWindowRow {
  return {
    window_start: at(sec),
    window_ms: 20_000,
    pointer_events: 30,
    pointer_leaves: 0,
    pointer_outside_ms: 0,
    longest_outside_ms: 0,
    outside_edge: null,
    untrusted_events: 0,
    teleports: 0,
    robotic_segments: 0,
    path_straightness: null,
    velocity_cv: null,
    context_menus: 0,
    selections: 0,
    keys: 10,
    chars: 10,
    corrections: 0,
    mean_dwell_ms: 90,
    mean_interval_ms: 200,
    interval_cv: 0.4,
    wpm: 25,
    injections: 0,
    idle_pointer_injections: 0,
    drift_z_dwell: null,
    drift_z_interval: null,
    ...overrides,
  };
}

/** `n` keystrokes spread over `spanSec` seconds starting at `sec`. */
function keystrokes(sec: number, n: number, spanSec = 8) {
  return Array.from({ length: n }, (_, i) => ({
    created_at: at(sec + (spanSec * i) / Math.max(1, n - 1)),
    question_version_id: 'q1',
    dwell_ms: 90,
    flight_ms: 180,
  }));
}

describe('notes_or_second_screen', () => {
  // Ten glances to the same left-hand spot from minute 5 on; six of them are followed by typing.
  const notesGlances = Array.from({ length: 10 }, (_, i) =>
    gaze(300 + i * 60, 3000, 'left', -30 + (i % 3) - 1, 2 + (i % 2)),
  );
  const typingAfterSix = Array.from({ length: 6 }, (_, i) =>
    window(300 + i * 60 + 4, { chars: 60, keys: 60, wpm: 70 }),
  );

  it('finds repeated glances to one region followed by typing bursts', () => {
    const result = buildFindings(rows({ gaze: notesGlances, input: typingAfterSix }));
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.type).toBe('notes_or_second_screen');
    expect(finding.confidence).toBe('medium');
    expect(finding.id).toBe(`notes_or_second_screen:${finding.windows[0]!.start}`);
    // Glances a minute apart merge into one window: first glance to last typing span.
    expect(finding.windows).toEqual([{ start: at(300), end: at(613) }]);
    expect(finding.reasons[0]).toBe(
      'The student looked to the left towards about the same spot 10 times.',
    );
    expect(finding.reasons[1]).toContain('6 of those glances were followed within 10 s');
    expect(finding.studentNote).toBeNull();
    expect(result.level).toBe('glance');
    expect(result.topReason).toBe('Repeated glances to the same spot, then typing');
  });

  it('splits regions more than ± regionDegrees apart and needs enough glances per region', () => {
    const scattered = notesGlances.map((g, i) => ({ ...g, yaw: i % 2 === 0 ? -30 : -60 }));
    expect(buildFindings(rows({ gaze: scattered, input: typingAfterSix })).findings).toEqual([]);
  });

  it('ignores thinking glances upward with no typing after them', () => {
    const thinking = Array.from({ length: 12 }, (_, i) => gaze(240 + i * 45, 2500, 'up', 1, 25));
    const slowTyping = Array.from({ length: 12 }, (_, i) =>
      window(240 + i * 45 + 20, { chars: 8, keys: 8 }),
    );
    expect(buildFindings(rows({ gaze: thinking, input: slowTyping })).findings).toEqual([]);
  });

  it('treats a region the student already used at the same rate in the first minutes as a habit', () => {
    // A hunt-and-peck typist looks down at the keyboard every 30 s from the start.
    const keyboard = Array.from({ length: 16 }, (_, i) => gaze(10 + i * 30, 1500, 'down', 0, -35));
    const typing = Array.from({ length: 16 }, (_, i) =>
      window(10 + i * 30 + 2, { chars: 50, keys: 50 }),
    );
    const result = buildFindings(
      rows({ meta: { ...meta, submittedAt: at(500) }, gaze: keyboard, input: typing }),
    );
    expect(result.findings).toEqual([]);
  });

  it('raises the typing-burst floor from the student’s own baseline', () => {
    // A fast typist: 200 chars per 20 s window throughout the first 3 minutes.
    const baseline = Array.from({ length: 9 }, (_, i) => window(i * 20, { chars: 200, keys: 200 }));
    // The same 60-char windows that count as a burst for an average typist are ordinary here.
    const later = Array.from({ length: 10 }, (_, i) => gaze(300 + i * 60, 3000, 'left', -30, 2));
    const after = Array.from({ length: 10 }, (_, i) =>
      window(300 + i * 60 + 4, { chars: 60, keys: 60 }),
    );
    const result = buildFindings(rows({ gaze: later, input: [...baseline, ...after] }));
    expect(result.findings).toEqual([]);
  });
});

describe('second_person', () => {
  it('combines a second face with transcribed speech into a high-confidence finding', () => {
    const result = buildFindings(
      rows({
        gaze: [gaze(400, 4000, 'multiple_faces'), gaze(900, 6000, 'multiple_faces')],
        voice: [{ detected_at: at(402), duration_ms: 5000, peak_db: -20 }],
        transcripts: [
          { captured_at: at(405), text: 'try the second option' },
          { captured_at: at(1500), text: 'unrelated later chatter' },
        ],
        evidence: [
          { id: 'ev-1', source: 'webcam', trigger: 'multiple_faces', captured_at: at(403) },
          { id: 'ev-2', source: 'webcam', trigger: 'multiple_faces', captured_at: at(914) },
          { id: 'ev-3', source: 'webcam', trigger: 'no_face', captured_at: at(1200) },
        ],
      }),
    );
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.type).toBe('second_person');
    expect(finding.confidence).toBe('high');
    expect(finding.evidenceIds).toEqual(['ev-1', 'ev-2']);
    expect(finding.transcript).toEqual([{ at: at(405), text: 'try the second option' }]);
    expect(finding.windows).toEqual([
      { start: at(400), end: at(407) },
      { start: at(900), end: at(906) },
    ]);
    expect(result.level).toBe('review');
  });

  it('does not react to a single extra-face frame', () => {
    expect(buildFindings(rows({ gaze: [gaze(400, 600, 'multiple_faces')] })).findings).toEqual([]);
  });

  it('needs the student in view for speech to count, and one speech pair is only a low lead', () => {
    const speech = {
      voice: [{ detected_at: at(402), duration_ms: 5000, peak_db: -20 }],
      transcripts: [{ captured_at: at(405), text: 'try the second option' }],
    };
    expect(
      buildFindings(rows({ ...speech, gaze: [gaze(395, 20_000, 'no_face')] })).findings,
    ).toEqual([]);
    const present = buildFindings(rows(speech));
    expect(present.findings.map((f) => [f.type, f.confidence])).toEqual([['second_person', 'low']]);
    expect(present.level).toBe('glance');
  });
});

describe('external_answer_entry', () => {
  it('flags repeated injected text with a still pointer as high confidence', () => {
    const result = buildFindings(
      rows({
        apps: [flag(300, 'text_injected'), flag(700, 'text_injected')],
        input: [window(290, { injections: 1, idle_pointer_injections: 1, pointer_events: 0 })],
        evidence: [
          { id: 'ev-1', source: 'webcam', trigger: 'text_injected', captured_at: at(301) },
        ],
      }),
    );
    expect(result.findings.map((f) => [f.type, f.confidence])).toEqual([
      ['external_answer_entry', 'high'],
    ]);
    expect(result.findings[0]!.evidenceIds).toEqual(['ev-1']);
    expect(result.findings[0]!.reasons[0]).toBe(
      'A long stretch of answer text appeared at once 2 times while the mouse was still.',
    );
  });

  it('treats a burst after idle with a still pointer as a low lead on its own', () => {
    const result = buildFindings(
      rows({
        apps: [flag(600, 'burst_after_idle')],
        input: [
          window(560, { pointer_events: 0, keys: 0, chars: 0 }),
          window(580, { pointer_events: 0 }),
        ],
      }),
    );
    expect(result.findings.map((f) => [f.type, f.confidence])).toEqual([
      ['external_answer_entry', 'low'],
    ]);
  });

  it('ignores a single injection with a moving pointer, and a slow typist entirely', () => {
    expect(
      buildFindings(rows({ apps: [flag(300, 'text_injected')], input: [window(290)] })).findings,
    ).toEqual([]);
    const slow = Array.from({ length: 40 }, (_, i) =>
      window(i * 20, { chars: 12, keys: 14, wpm: 12 }),
    );
    expect(
      buildFindings(rows({ input: slow, keystrokes: keystrokes(100, 30, 400) })).findings,
    ).toEqual([]);
  });
});

describe('phone_use', () => {
  it('pairs a long downward gaze with the iPhone leaving the app', () => {
    const result = buildFindings(
      rows({ gaze: [gaze(300, 7000, 'down', 0, -40)], apps: [flag(330, 'phone_left_app')] }),
    );
    expect(result.findings.map((f) => [f.type, f.confidence])).toEqual([['phone_use', 'medium']]);
    expect(result.findings[0]!.windows).toEqual([{ start: at(300), end: at(330) }]);
  });

  it('becomes high confidence when the camera also saw a phone nearby', () => {
    const result = buildFindings(
      rows({
        gaze: [gaze(300, 7000, 'down', 0, -40)],
        apps: [flag(310, 'phone_detected'), flag(330, 'iphone_lost')],
        evidence: [
          { id: 'ev-p', source: 'webcam', trigger: 'phone_detected', captured_at: at(311) },
        ],
      }),
    );
    expect(result.findings[0]).toMatchObject({
      type: 'phone_use',
      confidence: 'high',
      evidenceIds: ['ev-p'],
    });
  });

  it('ignores a calculator user: brief downward glances, a few keys each, no phone signals', () => {
    const glances = Array.from({ length: 10 }, (_, i) => gaze(300 + i * 40, 2000, 'down', 0, -38));
    const keys = glances.flatMap((_, i) => keystrokes(303 + i * 40, 4, 3));
    const result = buildFindings(rows({ gaze: glances, keystrokes: keys }));
    expect(result.findings).toEqual([]);
    expect(result.level).toBe('none');
  });

  it('ignores one phone sighting or one dropped connection on its own', () => {
    expect(buildFindings(rows({ apps: [flag(300, 'phone_detected')] })).findings).toEqual([]);
    expect(buildFindings(rows({ apps: [flag(300, 'iphone_lost')] })).findings).toEqual([]);
    expect(
      buildFindings(rows({ apps: [flag(300, 'phone_detected'), flag(900, 'phone_detected')] }))
        .findings[0],
    ).toMatchObject({ type: 'phone_use', confidence: 'medium' });
  });
});

describe('left_exam', () => {
  it('counts distinct interruptions (focus loss and hidden page together are one)', () => {
    const result = buildFindings(
      rows({
        apps: [
          flag(100, 'focus_lost'),
          flag(101, 'page_hidden'),
          flag(400, 'focus_lost'),
          flag(800, 'screen_recording_stopped'),
        ],
      }),
    );
    expect(result.findings.map((f) => [f.type, f.confidence])).toEqual([['left_exam', 'medium']]);
    expect(result.findings[0]!.reasons[0]).toBe(
      'The exam was left or interrupted 3 times: the exam window lost focus (2), the exam tab was hidden (1), screen recording stopped (1).',
    );
  });

  it('ignores a single focus loss and a single failed presence check', () => {
    expect(buildFindings(rows({ apps: [flag(100, 'focus_lost')] })).findings).toEqual([]);
    expect(buildFindings(rows({ apps: [flag(100, 'presence_check_failed')] })).findings).toEqual(
      [],
    );
    expect(
      buildFindings(
        rows({ apps: [flag(100, 'presence_check_failed'), flag(700, 'presence_check_failed')] }),
      ).findings[0],
    ).toMatchObject({ type: 'left_exam', confidence: 'low' });
  });
});

describe('environment_risk', () => {
  it('reports a virtual camera, and raises confidence with a second signal', () => {
    expect(
      buildFindings(rows({ apps: [flag(5, 'virtual_camera_connected')] })).findings[0],
    ).toMatchObject({ type: 'environment_risk', confidence: 'medium' });
    expect(
      buildFindings(
        rows({
          apps: [flag(5, 'camera_swapped_to_virtual'), flag(20, 'capture_display_connected')],
        }),
      ).findings[0],
    ).toMatchObject({ type: 'environment_risk', confidence: 'high' });
  });

  it('does not report an unverified camera alone, only together with another weak signal', () => {
    expect(buildFindings(rows({ apps: [flag(5, 'camera_unverified')] })).findings).toEqual([]);
    const two = buildFindings(
      rows({ apps: [flag(5, 'camera_unverified'), { ...flag(30, 'focus_lost', 2) }] }),
    );
    expect(two.findings.map((f) => [f.type, f.confidence])).toEqual([['environment_risk', 'low']]);
  });
});

describe('assembly', () => {
  it('orders by confidence then priority, caps windows, and sets the level', () => {
    const result = buildFindings(
      rows({
        apps: [
          flag(100, 'focus_lost'),
          flag(400, 'focus_lost'),
          flag(800, 'focus_lost'),
          flag(5, 'virtual_camera_connected'),
          flag(300, 'text_injected'),
          flag(700, 'text_injected'),
        ],
      }),
    );
    expect(result.findings.map((f) => [f.type, f.confidence])).toEqual([
      ['external_answer_entry', 'medium'],
      ['left_exam', 'medium'],
      ['environment_risk', 'medium'],
    ]);
    expect(result.level).toBe('review');
    expect(result.topReason).toBe('Answer text that appeared at once');
    expect(result.attemptId).toBe('a1');
    for (const f of result.findings) {
      expect(f.windows.length).toBeLessThanOrEqual(FINDING_THRESHOLDS.maxWindows);
      for (const w of f.windows) expect(Date.parse(w.start)).toBeLessThanOrEqual(Date.parse(w.end));
    }
  });

  it('computes the review level from confidence counts', () => {
    expect(reviewLevel([])).toBe('none');
    expect(reviewLevel([{ confidence: 'low' }])).toBe('glance');
    expect(reviewLevel([{ confidence: 'medium' }])).toBe('glance');
    expect(reviewLevel([{ confidence: 'medium' }, { confidence: 'medium' }])).toBe('review');
    expect(reviewLevel([{ confidence: 'high' }])).toBe('review');
  });

  it('produces nothing for an empty attempt', () => {
    expect(buildFindings(rows())).toEqual({
      attemptId: 'a1',
      level: 'none',
      findings: [],
      topReason: null,
    });
  });
});

describe('IntegrityService.getFindings over a real database', () => {
  let db!: DatabaseSync;
  let service!: IntegrityService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DROP TRIGGER published_assignment_only;');
    db.exec(`
      INSERT INTO users (id, email, password_hash, role, created_at)
        VALUES ('u1', 's@example.test', 'x', 'student', '2026-09-01T00:00:00.000Z');
      INSERT INTO exam_versions (id, exam_id, version_number, title, status, duration_seconds, created_at, published_at)
        VALUES ('v1', 'e1', 1, 'Quiz', 'published', 3600, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
      INSERT INTO exam_assignments (id, exam_version_id, student_id, assigned_at)
        VALUES ('as1', 'v1', 'u1', '2026-09-15T00:00:00.000Z');
      INSERT INTO exam_attempts (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
        VALUES ('a1', 'as1', 'in_progress', 's', '2026-09-15T00:00:00.000Z', '2026-09-15T01:00:00.000Z', '2026-09-15T01:00:00.000Z');
    `);
    service = new IntegrityService(new IntegrityRepository(db), null);
  });
  afterEach(() => db.close());

  it('returns null for an unknown attempt', () => {
    expect(service.getFindings('nope')).toBeNull();
  });

  it('caches per attempt for 30 s and feeds the instructor list', () => {
    const now = Date.now();
    expect(service.getFindings('a1', now)?.level).toBe('none');
    service.recordAppEvent('a1', 'flag:text_injected', 1);
    service.recordAppEvent('a1', 'flag:text_injected', 1);
    db.prepare(`UPDATE app_events SET created_at = ? WHERE rowid = 2`).run(at(500));
    expect(service.getFindings('a1', now + FINDINGS_CACHE_MS - 1)?.level).toBe('none');
    const fresh = service.getFindings('a1', now + FINDINGS_CACHE_MS);
    expect(fresh?.findings.map((f) => f.type)).toEqual(['external_answer_entry']);
    expect(service.listAttemptsForInstructor()).toEqual([
      expect.objectContaining({
        id: 'a1',
        level: 'glance',
        topReason: 'Answer text that appeared at once',
        findingCount: 1,
      }),
    ]);
  });

  it('fills studentNote only when a finding_notes table exists', () => {
    service.recordAppEvent('a1', 'flag:text_injected', 1);
    service.recordAppEvent('a1', 'flag:text_injected', 1);
    db.prepare(`UPDATE app_events SET created_at = ? WHERE rowid = 2`).run(at(500));
    // Simulate a database from before the finding_notes migration.
    db.exec('DROP TABLE IF EXISTS finding_notes');
    const before = service.getFindings('a1', 0)!;
    expect(before.findings[0]!.studentNote).toBeNull();
    db.exec(
      `CREATE TABLE finding_notes (attempt_id TEXT NOT NULL, finding_id TEXT NOT NULL, note TEXT NOT NULL)`,
    );
    db.prepare(`INSERT INTO finding_notes VALUES ('a1', ?, 'I used dictation.')`).run(
      before.findings[0]!.id,
    );
    const after = service.getFindings('a1', FINDINGS_CACHE_MS)!;
    expect(after.findings[0]!.studentNote).toBe('I used dictation.');
  });
});
