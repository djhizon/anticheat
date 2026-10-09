import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface LivenessChallengeRow {
  readonly nonce: string;
  readonly attempt_id: string;
  readonly challenge_type: string;
  readonly challenge_data: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly used: number;
}

export interface PhoneEnrollmentRow {
  readonly id: string;
  readonly attempt_id: string;
  readonly token: string;
  readonly last_seen_at: string | null;
  readonly created_at: string;
}

export interface InstructorVersionRow {
  readonly id: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly questions: Array<{
    readonly id: string;
    readonly prompt: string;
    readonly type: string;
  }>;
}

export const TIMELINE_ROW_LIMIT = 2000;

export interface TimelineAttemptMeta {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string;
  readonly submittedAt: string | null;
  readonly expiredAt: string | null;
  readonly studentId: string;
}

export interface TimelineAttemptListRow {
  readonly id: string;
  readonly student_email: string;
  readonly exam_title: string;
  readonly status: 'in_progress' | 'submitted' | 'expired';
  readonly started_at: string;
}

/** Raw, unmerged rows for one attempt; `buildTimeline` normalizes and merges them. */
export interface TimelineRows {
  readonly meta: TimelineAttemptMeta;
  readonly gaze: ReadonlyArray<{
    off_screen_start: string;
    duration_ms: number;
    direction: string;
    yaw: number | null;
    pitch: number | null;
  }>;
  readonly apps: ReadonlyArray<{
    created_at: string;
    foreground_app: string;
    display_count: number;
  }>;
  readonly keystrokes: ReadonlyArray<{
    created_at: string;
    question_version_id: string;
    dwell_ms: number;
    flight_ms: number;
  }>;
  readonly voice: ReadonlyArray<{ detected_at: string; duration_ms: number; peak_db: number }>;
  readonly liveness: ReadonlyArray<{
    created_at: string;
    layer: number;
    result: string;
    details_json: string;
  }>;
  readonly transcripts: ReadonlyArray<{ captured_at: string; text: string }>;
  readonly revisions: ReadonlyArray<{
    created_at: string;
    question_version_id: string;
    word_count: number;
  }>;
  readonly phones: ReadonlyArray<{ created_at: string; last_seen_at: string | null }>;
  readonly audits: ReadonlyArray<{ occurred_at: string; action: string }>;
  /** Metadata only: image bytes are never loaded into the timeline. */
  readonly evidence: ReadonlyArray<{
    id: string;
    source: string;
    trigger: string;
    captured_at: string;
  }>;
}

export class IntegrityRepository {
  getTransparencyEvents(attemptId: string) {
    const apps = this.db
      .prepare(
        `SELECT created_at, foreground_app, display_count FROM app_events WHERE attempt_id = ? AND (display_count > 1 OR foreground_app != '')`,
      )
      .all(attemptId) as unknown as Array<{
      created_at: string;
      foreground_app: string;
      display_count: number;
    }>;
    const liveness = this.db
      .prepare(
        `SELECT created_at, layer, result, details_json FROM liveness_events WHERE attempt_id = ? AND result = 'fail'`,
      )
      .all(attemptId) as unknown as Array<{
      created_at: string;
      layer: number;
      result: string;
      details_json: string;
    }>;
    const gaze = this.db
      .prepare(
        `SELECT created_at, duration_ms FROM gaze_events WHERE attempt_id = ? AND duration_ms > 3000`,
      )
      .all(attemptId) as unknown as Array<{ created_at: string; duration_ms: number }>;
    const voice = this.db
      .prepare(`SELECT created_at, duration_ms, peak_db FROM voice_events WHERE attempt_id = ?`)
      .all(attemptId) as unknown as Array<{
      created_at: string;
      duration_ms: number;
      peak_db: number;
    }>;
    return { apps, liveness, gaze, voice };
  }

  private readonly db: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.db = database;
  }

  // ── Answer Revisions ────────────────────────────────────────────────────────

  insertAnswerRevision(attemptId: string, questionVersionId: string, valueText: string): void {
    const wordCount = valueText.trim() === '' ? 0 : valueText.trim().split(/\s+/).length;
    this.db
      .prepare(
        `INSERT INTO answer_revisions (id, attempt_id, question_version_id, value_text, word_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, questionVersionId, valueText, wordCount);
  }

  getAnswerRevisions(
    attemptId: string,
    questionVersionId: string,
  ): ReadonlyArray<{ value_text: string; created_at: string; word_count: number }> {
    return this.db
      .prepare(
        `SELECT value_text, word_count, created_at FROM answer_revisions
         WHERE attempt_id = ? AND question_version_id = ?
         ORDER BY created_at ASC`,
      )
      .all(attemptId, questionVersionId) as unknown as ReadonlyArray<{
      value_text: string;
      created_at: string;
      word_count: number;
    }>;
  }

  // ── App Events (Electron companion) ─────────────────────────────────────────

  insertAppEvent(attemptId: string, foregroundApp: string, displayCount: number): void {
    this.db
      .prepare(
        `INSERT INTO app_events (id, attempt_id, foreground_app, display_count)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, foregroundApp, displayCount);
  }

  // ── Evidence snapshots (triggered still JPEGs, never video) ─────────────────

  insertEvidence(row: {
    readonly id: string;
    readonly attemptId: string;
    readonly source: string;
    readonly trigger: string;
    readonly capturedAt: string;
    readonly createdAt: string;
    readonly bytes: Buffer;
  }): void {
    this.db
      .prepare(
        `INSERT INTO evidence_snapshots (id, attempt_id, source, trigger, captured_at, created_at, mime, bytes)
         VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', ?)`,
      )
      .run(
        row.id,
        row.attemptId,
        row.source,
        row.trigger,
        row.capturedAt,
        row.createdAt,
        new Uint8Array(row.bytes),
      );
  }

  countEvidence(attemptId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM evidence_snapshots WHERE attempt_id = ?')
      .get(attemptId) as unknown as { n: number };
    return Number(row.n);
  }

  /** Snapshots saved for this (attempt, source, trigger) at or after the ISO time. */
  countEvidenceSince(attemptId: string, source: string, trigger: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM evidence_snapshots
         WHERE attempt_id = ? AND source = ? AND trigger = ? AND created_at >= ?`,
      )
      .get(attemptId, source, trigger, sinceIso) as unknown as { n: number };
    return Number(row.n);
  }

  listEvidence(
    attemptId: string,
  ): ReadonlyArray<{ id: string; source: string; trigger: string; captured_at: string }> {
    return this.db
      .prepare(
        `SELECT id, source, trigger, captured_at FROM evidence_snapshots
         WHERE attempt_id = ? ORDER BY captured_at ASC, rowid ASC`,
      )
      .all(attemptId) as unknown as ReadonlyArray<{
      id: string;
      source: string;
      trigger: string;
      captured_at: string;
    }>;
  }

  getEvidence(attemptId: string, id: string): { mime: string; bytes: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT mime, bytes FROM evidence_snapshots WHERE attempt_id = ? AND id = ?')
      .get(attemptId, id) as unknown as { mime: string; bytes: Uint8Array } | undefined;
    return row ?? null;
  }

  deleteEvidenceBefore(cutoffIso: string): number {
    const result = this.db
      .prepare('DELETE FROM evidence_snapshots WHERE created_at < ?')
      .run(cutoffIso);
    return Number(result.changes);
  }

  // ── Audio transcripts (text only; raw audio is never stored) ────────────────

  insertAudioTranscript(attemptId: string, capturedAt: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO audio_transcripts (id, attempt_id, captured_at, text)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, capturedAt, text);
  }

  /** Deletes transcript rows captured before the ISO cutoff. Returns the number removed. */
  deleteAudioTranscriptsBefore(cutoffIso: string): number {
    const result = this.db
      .prepare(`DELETE FROM audio_transcripts WHERE captured_at < ?`)
      .run(cutoffIso);
    return Number(result.changes);
  }

  getAudioTranscripts(
    attemptId: string,
    limit = 5000,
  ): ReadonlyArray<{ captured_at: string; text: string }> {
    return this.db
      .prepare(
        `SELECT captured_at, text FROM audio_transcripts
         WHERE attempt_id = ? ORDER BY captured_at ASC, rowid ASC LIMIT ?`,
      )
      .all(attemptId, limit) as unknown as ReadonlyArray<{ captured_at: string; text: string }>;
  }

  getRecentAppEvents(
    attemptId: string,
    limit = 50,
  ): ReadonlyArray<{ foreground_app: string; display_count: number; created_at: string }> {
    return this.db
      .prepare(
        `SELECT foreground_app, display_count, created_at FROM app_events
         WHERE attempt_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(attemptId, limit) as unknown as ReadonlyArray<{
      foreground_app: string;
      display_count: number;
      created_at: string;
    }>;
  }

  // ── Keystroke Dynamics ───────────────────────────────────────────────────────

  insertKeystrokeEvent(
    attemptId: string,
    questionVersionId: string,
    dwellMs: number,
    flightMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO keystroke_events (id, attempt_id, question_version_id, dwell_ms, flight_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, questionVersionId, dwellMs, flightMs);
  }

  // ── Gaze Events ──────────────────────────────────────────────────────────────

  insertGazeEvent(
    attemptId: string,
    offScreenStart: string,
    durationMs: number,
    direction = 'away',
    yaw: number | null = null,
    pitch: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO gaze_events (id, attempt_id, off_screen_start, duration_ms, direction, yaw, pitch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, offScreenStart, durationMs, direction, yaw, pitch);
  }

  // ── Unified integrity log (read model) ──────────────────────────────────────

  /** Attempt facts for the log, or null when the attempt does not exist. */
  getAttemptTimelineMeta(attemptId: string): TimelineAttemptMeta | null {
    const row = this.db
      .prepare(
        `SELECT t.id, t.status, t.started_at, t.submitted_at, t.expired_at, a.student_id
           FROM exam_attempts t JOIN exam_assignments a ON a.id = t.assignment_id
          WHERE t.id = ?`,
      )
      .get(attemptId) as
      | {
          id: string;
          status: string;
          started_at: string;
          submitted_at: string | null;
          expired_at: string | null;
          student_id: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          status: row.status,
          startedAt: row.started_at,
          submittedAt: row.submitted_at,
          expiredAt: row.expired_at,
          studentId: row.student_id,
        };
  }

  /** Every stored signal for one attempt, unmerged. Each list is capped. */
  getTimelineRows(attemptId: string, meta: TimelineAttemptMeta): TimelineRows {
    const all = <T>(sql: string, ...params: Array<string | number>): T[] =>
      this.db.prepare(sql).all(...params) as unknown as T[];
    const end = meta.submittedAt ?? meta.expiredAt ?? '9999-12-31T23:59:59.999Z';
    return {
      meta,
      gaze: all(
        `SELECT off_screen_start, duration_ms, direction, yaw, pitch FROM gaze_events
          WHERE attempt_id = ? ORDER BY off_screen_start LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      apps: all(
        `SELECT created_at, foreground_app, display_count FROM app_events
          WHERE attempt_id = ? ORDER BY created_at LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      keystrokes: all(
        `SELECT created_at, question_version_id, dwell_ms, flight_ms FROM keystroke_events
          WHERE attempt_id = ? ORDER BY created_at LIMIT ${TIMELINE_ROW_LIMIT * 10}`,
        attemptId,
      ),
      voice: all(
        `SELECT detected_at, duration_ms, peak_db FROM voice_events
          WHERE attempt_id = ? ORDER BY detected_at LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      liveness: all(
        `SELECT created_at, layer, result, details_json FROM liveness_events
          WHERE attempt_id = ? ORDER BY created_at LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      transcripts: all(
        `SELECT captured_at, text FROM audio_transcripts
          WHERE attempt_id = ? ORDER BY captured_at, rowid LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      revisions: all(
        `SELECT created_at, question_version_id, word_count FROM answer_revisions
          WHERE attempt_id = ? ORDER BY created_at, rowid LIMIT ${TIMELINE_ROW_LIMIT}`,
        attemptId,
      ),
      phones: all(
        `SELECT created_at, last_seen_at FROM phone_enrollments
          WHERE attempt_id = ? ORDER BY created_at LIMIT 20`,
        attemptId,
      ),
      audits: all(
        `SELECT occurred_at, action FROM audit_events
          WHERE actor_user_id = ? AND occurred_at >= ? AND occurred_at <= ?
          ORDER BY occurred_at LIMIT 50`,
        meta.studentId,
        meta.startedAt,
        end,
      ),
      evidence: all(
        `SELECT id, source, trigger, captured_at FROM evidence_snapshots
          WHERE attempt_id = ? ORDER BY captured_at, rowid LIMIT 100`,
        attemptId,
      ),
    };
  }

  /** Newest attempts across all students for the instructor review list. */
  listAttemptsForInstructor(limit = 200): TimelineAttemptListRow[] {
    return this.db
      .prepare(
        `SELECT t.id, u.email AS student_email, e.title AS exam_title, t.status, t.started_at
           FROM exam_attempts t
           JOIN exam_assignments a ON a.id = t.assignment_id
           JOIN users u ON u.id = a.student_id
           JOIN exam_versions e ON e.id = a.exam_version_id
          ORDER BY t.started_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as TimelineAttemptListRow[];
  }

  // ── Liveness Events ──────────────────────────────────────────────────────────

  insertLivenessEvent(
    attemptId: string,
    layer: number,
    result: 'pass' | 'fail' | 'skip',
    nonce: string | null,
    detailsJson: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO liveness_events (id, attempt_id, layer, result, nonce, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, layer, result, nonce, detailsJson);
  }

  // ── Liveness Challenges ──────────────────────────────────────────────────────

  insertLivenessChallenge(
    nonce: string,
    attemptId: string,
    challengeType: string,
    challengeDataJson: string,
    expiresAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO liveness_challenges (nonce, attempt_id, challenge_type, challenge_data, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nonce, attemptId, challengeType, challengeDataJson, expiresAt);
  }

  countLivenessChallengesSince(attemptId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM liveness_challenges WHERE attempt_id = ? AND issued_at >= ?`,
      )
      .get(attemptId, sinceIso) as { n: number };
    return row.n;
  }

  getLivenessChallenge(nonce: string): LivenessChallengeRow | null {
    const row = this.db.prepare(`SELECT * FROM liveness_challenges WHERE nonce = ?`).get(nonce) as
      LivenessChallengeRow | undefined;
    return row ?? null;
  }

  markLivenessChallengeUsed(nonce: string): void {
    this.db.prepare(`UPDATE liveness_challenges SET used = 1 WHERE nonce = ?`).run(nonce);
  }

  // ── Instructor: similarity review ────────────────────────────────────────────

  /** Published exam versions with their free-text questions (the ones worth comparing). */
  listVersionsWithTextQuestions(): InstructorVersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT v.id AS version_id, v.title, v.version_number, q.id AS question_id, q.prompt, q.question_type
           FROM exam_versions v
           JOIN exam_version_questions evq ON evq.exam_version_id = v.id
           JOIN question_versions q ON q.id = evq.question_version_id
          WHERE v.status = 'published' AND q.question_type IN ('identification', 'short_answer')
          ORDER BY v.published_at DESC, v.id, evq.position`,
      )
      .all() as Array<{
      version_id: string;
      title: string;
      version_number: number;
      question_id: string;
      prompt: string;
      question_type: string;
    }>;
    const versions = new Map<string, InstructorVersionRow>();
    for (const row of rows) {
      let version = versions.get(row.version_id);
      if (version === undefined) {
        version = {
          id: row.version_id,
          title: row.title,
          versionNumber: row.version_number,
          questions: [],
        };
        versions.set(row.version_id, version);
      }
      version.questions.push({ id: row.question_id, prompt: row.prompt, type: row.question_type });
    }
    return [...versions.values()];
  }

  /** Every non-empty text answer to one question of one exam version, with the student's email. */
  listTextAnswers(
    examVersionId: string,
    questionVersionId: string,
  ): Array<{ studentId: string; email: string; text: string }> {
    const rows = this.db
      .prepare(
        `SELECT u.id AS student_id, u.email, a.answer_json
           FROM attempt_answers a
           JOIN exam_attempts t ON t.id = a.attempt_id
           JOIN exam_assignments s ON s.id = t.assignment_id
           JOIN users u ON u.id = s.student_id
          WHERE s.exam_version_id = ? AND a.question_version_id = ?
          ORDER BY u.email`,
      )
      .all(examVersionId, questionVersionId) as Array<{
      student_id: string;
      email: string;
      answer_json: string;
    }>;
    return rows.flatMap((row) => {
      const value: unknown = JSON.parse(row.answer_json);
      return typeof value === 'string' && value.trim() !== ''
        ? [{ studentId: row.student_id, email: row.email, text: value }]
        : [];
    });
  }

  // ── Phone Enrollment ─────────────────────────────────────────────────────────

  insertPhoneEnrollment(attemptId: string, token: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO phone_enrollments (id, attempt_id, token)
         VALUES (?, ?, ?)`,
      )
      .run(id, attemptId, token);
    return id;
  }

  getPhoneEnrollmentByToken(token: string): PhoneEnrollmentRow | null {
    const row = this.db.prepare(`SELECT * FROM phone_enrollments WHERE token = ?`).get(token) as
      PhoneEnrollmentRow | undefined;
    return row ?? null;
  }

  getPhoneEnrollmentByAttempt(attemptId: string): PhoneEnrollmentRow | null {
    const query = `SELECT * FROM phone_enrollments WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1`;
    return (this.db.prepare(query).get(attemptId) as PhoneEnrollmentRow | undefined) ?? null;
  }

  updatePhoneHeartbeat(token: string, lastSeenAt: string): void {
    this.db
      .prepare(`UPDATE phone_enrollments SET last_seen_at = ? WHERE token = ?`)
      .run(lastSeenAt, token);
  }

  // ── Voice Events ─────────────────────────────────────────────────────────────

  insertVoiceEvent(
    attemptId: string,
    detectedAt: string,
    durationMs: number,
    peakDb: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO voice_events (id, attempt_id, detected_at, duration_ms, peak_db)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, detectedAt, durationMs, peakDb);
  }

  // ── Audio Sessions ────────────────────────────────────────────────────────────

  insertAudioSession(attemptId: string, blobPath: string, durationMs: number): void {
    this.db
      .prepare(
        `INSERT INTO audio_sessions (id, attempt_id, blob_path, duration_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, blobPath, durationMs);
  }

  /** Save audio blob to disk and record the path */
  saveAudioBlob(
    attemptId: string,
    buffer: Buffer,
    durationMs: number,
    audioDir = './data/audio',
  ): string {
    mkdirSync(audioDir, { recursive: true });
    const filename = `${attemptId}-${Date.now()}.webm`;
    const fullPath = join(audioDir, filename);
    writeFileSync(fullPath, buffer);
    this.insertAudioSession(attemptId, fullPath, durationMs);
    return fullPath;
  }
}
