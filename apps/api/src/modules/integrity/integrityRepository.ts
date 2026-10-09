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

  // ── Audio transcripts (text only; raw audio is never stored) ────────────────

  insertAudioTranscript(attemptId: string, capturedAt: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO audio_transcripts (id, attempt_id, captured_at, text)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, capturedAt, text);
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

  insertGazeEvent(attemptId: string, offScreenStart: string, durationMs: number): void {
    this.db
      .prepare(
        `INSERT INTO gaze_events (id, attempt_id, off_screen_start, duration_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), attemptId, offScreenStart, durationMs);
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
