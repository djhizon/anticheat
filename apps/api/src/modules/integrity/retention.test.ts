import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../db/client.js';
import { IntegrityRepository } from './integrityRepository.js';
import { IntegrityService } from './integrityService.js';

/**
 * Retention sweeps against a real schema: one retention window per exam (server defaults when
 * unset), uploaded-recording metadata, and the 7-day purge after a teacher marks an attempt fine.
 */
let db!: DatabaseSync;
let repo!: IntegrityRepository;

const NOW = new Date('2026-10-11T00:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** Creates exam → version → assignment → attempt with the given exam-level retention. */
function attemptFor(exam: string, retainDays: number | null, attempt = `${exam}-attempt`): string {
  db.prepare('INSERT INTO exams (id, slug, created_at, retain_days) VALUES (?, ?, ?, ?)').run(
    exam,
    `slug-${exam}`,
    daysAgo(100),
    retainDays,
  );
  db.prepare(
    `INSERT INTO exam_versions
       (id, exam_id, version_number, title, duration_seconds, status, created_at, published_at)
     VALUES (?, ?, 1, 'Exam', 60, 'published', ?, ?)`,
  ).run(`${exam}-v1`, exam, daysAgo(100), daysAgo(100));
  db.prepare(
    `INSERT INTO exam_assignments (id, exam_version_id, student_id, assigned_at)
     VALUES (?, ?, 'student-1', ?)`,
  ).run(`${attempt}-assignment`, `${exam}-v1`, daysAgo(90));
  db.prepare(
    `INSERT INTO exam_attempts
       (id, assignment_id, status, attempt_seed, started_at, base_deadline, effective_deadline)
     VALUES (?, ?, 'in_progress', 'seed', ?, ?, ?)`,
  ).run(attempt, `${attempt}-assignment`, daysAgo(90), daysAgo(89), daysAgo(89));
  return attempt;
}

function addMedia(attemptId: string, ageDays: number): void {
  const at = daysAgo(ageDays);
  repo.insertAudioTranscript(attemptId, at, `transcript ${attemptId}`);
  repo.insertEvidence({
    id: `${attemptId}-ev-${ageDays}`,
    attemptId,
    source: 'webcam',
    trigger: 'no_face',
    capturedAt: at,
    createdAt: at,
    bytes: Buffer.from([0xff, 0xd8, 0xff, 1]),
  });
  repo.insertRecordingSegment(attemptId, 'student-1', ageDays, 1234, at);
}

function mediaCounts(attemptId: string): {
  transcripts: number;
  evidence: number;
  segments: number;
} {
  return {
    transcripts: repo.getAudioTranscripts(attemptId).length,
    evidence: repo.countEvidence(attemptId),
    segments: repo.listRecordingSegments(attemptId).length,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  // Student rows are irrelevant to retention; the fixture only needs the exam chain.
  db.exec('PRAGMA foreign_keys = OFF;');
  repo = new IntegrityRepository(db);
});

afterEach(() => db.close());

it('applies each exam retention window, with the server default for exams without one', () => {
  const custom = attemptFor('short', 5); // exam keeps media 5 days
  const fallback = attemptFor('default', null); // server default (10 days below)
  const forever = attemptFor('forever', 0); // 0 = keep until the attempt is removed
  for (const attempt of [custom, fallback, forever]) {
    addMedia(attempt, 7);
    addMedia(attempt, 20);
    addMedia(attempt, 1);
  }
  const remote = vi.fn(async () => undefined);
  const svc = new IntegrityService(repo, null, 'secret', 10, 10, true, remote);

  const result = svc.sweepRetention(NOW);

  // short: 7 d and 20 d gone; default: 20 d gone; forever: nothing.
  expect(result).toEqual({ transcripts: 3, evidence: 3, recordings: 3, reviewedFine: 0 });
  expect(mediaCounts(custom)).toEqual({ transcripts: 1, evidence: 1, segments: 1 });
  expect(mediaCounts(fallback)).toEqual({ transcripts: 2, evidence: 2, segments: 2 });
  expect(mediaCounts(forever)).toEqual({ transcripts: 3, evidence: 3, segments: 3 });
  expect(remote).toHaveBeenCalledTimes(1);
  expect(remote.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      { attempt_id: custom, segment_index: 7, student_id: 'student-1' },
      { attempt_id: custom, segment_index: 20, student_id: 'student-1' },
      { attempt_id: fallback, segment_index: 20, student_id: 'student-1' },
    ]),
  );
});

it('uses separate transcript and evidence defaults only when the exam has no setting', () => {
  const custom = attemptFor('custom', 3);
  const fallback = attemptFor('plain', null);
  addMedia(custom, 4);
  addMedia(fallback, 4);
  // Transcripts default to 2 days, photos/recordings to 30 days.
  const svc = new IntegrityService(repo, null, 'secret', 2, 30);
  expect(svc.sweepRetention(NOW)).toEqual({
    transcripts: 2,
    evidence: 1,
    recordings: 1,
    reviewedFine: 0,
  });
  expect(mediaCounts(custom)).toEqual({ transcripts: 0, evidence: 0, segments: 0 });
  expect(mediaCounts(fallback)).toEqual({ transcripts: 0, evidence: 1, segments: 1 });
});

it('is a no-op for "marked fine" attempts until review_decisions exists', () => {
  const attempt = attemptFor('exam', null);
  addMedia(attempt, 1);
  const svc = new IntegrityService(repo, null, 'secret', 30, 30);
  expect(repo.hasReviewDecisions()).toBe(false);
  expect(svc.sweepReviewedFine(NOW)).toBe(0);
  expect(mediaCounts(attempt)).toEqual({ transcripts: 1, evidence: 1, segments: 1 });
});

it('deletes media of attempts marked fine more than 7 days ago and keeps the findings', () => {
  // The table is created by a later migration; this mirrors its minimal shape.
  db.exec(`CREATE TABLE review_decisions (
    id INTEGER PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('fine', 'follow_up')),
    decided_at TEXT NOT NULL
  )`);
  const oldFine = attemptFor('old-fine', 0, 'old-fine');
  const recentFine = attemptFor('recent-fine', 0, 'recent-fine');
  const reopened = attemptFor('reopened', 0, 'reopened');
  const followUp = attemptFor('follow-up', 0, 'follow-up');
  for (const attempt of [oldFine, recentFine, reopened, followUp]) {
    addMedia(attempt, 1);
    repo.insertAppEvent(attempt, 'Calculator', 1);
  }
  const decide = (attempt: string, decision: string, ageDays: number) =>
    db
      .prepare('INSERT INTO review_decisions (attempt_id, decision, decided_at) VALUES (?, ?, ?)')
      .run(attempt, decision, daysAgo(ageDays));
  decide(oldFine, 'fine', 8);
  decide(recentFine, 'fine', 6);
  decide(reopened, 'fine', 9);
  decide(reopened, 'follow_up', 8); // latest decision wins
  decide(followUp, 'follow_up', 30);

  const remote = vi.fn(async () => undefined);
  const svc = new IntegrityService(repo, null, 'secret', 30, 30, true, remote);
  expect(svc.sweepReviewedFine(NOW)).toBe(1);

  expect(mediaCounts(oldFine)).toEqual({ transcripts: 0, evidence: 0, segments: 0 });
  expect(repo.getRecentAppEvents(oldFine)).toHaveLength(1); // findings and timeline rows stay
  for (const kept of [recentFine, reopened, followUp]) {
    expect(mediaCounts(kept)).toEqual({ transcripts: 1, evidence: 1, segments: 1 });
  }
  expect(remote).toHaveBeenCalledWith([
    { attempt_id: oldFine, segment_index: 1, student_id: 'student-1' },
  ]);
  // Re-running is idempotent and does not call the remote deleter again.
  expect(svc.sweepReviewedFine(NOW)).toBe(1);
  expect(remote).toHaveBeenCalledTimes(1);
});

it('reports exam privacy settings in the instructor attempt list', () => {
  db.prepare(
    `INSERT INTO users (id, email, role, password_hash, created_at)
              VALUES ('student-1', 'student@example.test', 'student', 'x', ?)`,
  ).run(daysAgo(100));
  attemptFor('tuned', 12, 'tuned-attempt');
  db.prepare(`UPDATE exams SET recording_upload = 'off' WHERE id = 'tuned'`).run();
  attemptFor('plain', null, 'plain-attempt');
  const svc = new IntegrityService(repo, null, 'secret', 20, 40, true);
  const byId = new Map(svc.listAttemptsForInstructor().map((row) => [row.id, row.privacy]));
  expect(byId.get('tuned-attempt')).toEqual({
    retainDays: 12,
    evidenceRetainDays: 12,
    transcriptRetainDays: 12,
    recordingUpload: false,
  });
  expect(byId.get('plain-attempt')).toEqual({
    retainDays: null,
    evidenceRetainDays: 40,
    transcriptRetainDays: 20,
    recordingUpload: true,
  });
});
