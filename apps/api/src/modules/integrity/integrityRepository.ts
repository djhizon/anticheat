import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

export class IntegrityRepository {
  getTransparencyEvents(attemptId: string) {
    const apps = this.db.prepare(`SELECT created_at, foreground_app, display_count FROM app_events WHERE attempt_id = ? AND (display_count > 1 OR foreground_app != '')`).all(attemptId) as any[];
    const liveness = this.db.prepare(`SELECT created_at, layer, result, details_json FROM liveness_events WHERE attempt_id = ? AND result = 'fail'`).all(attemptId) as any[];
    const gaze = this.db.prepare(`SELECT created_at, duration_ms FROM gaze_events WHERE attempt_id = ? AND duration_ms > 3000`).all(attemptId) as any[];
    const voice = this.db.prepare(`SELECT created_at, duration_ms, peak_db FROM voice_events WHERE attempt_id = ?`).all(attemptId) as any[];
    return { apps, liveness, gaze, voice };
  }

  private readonly db: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.db = database;
  }

  // ── Answer Revisions ────────────────────────────────────────────────────────

  insertAnswerRevision(
    attemptId: string,
    questionVersionId: string,
    valueText: string,
  ): void {
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

  getLivenessChallenge(nonce: string): LivenessChallengeRow | null {
    const row = this.db
      .prepare(`SELECT * FROM liveness_challenges WHERE nonce = ?`)
      .get(nonce) as LivenessChallengeRow | undefined;
    return row ?? null;
  }

  markLivenessChallengeUsed(nonce: string): void {
    this.db
      .prepare(`UPDATE liveness_challenges SET used = 1 WHERE nonce = ?`)
      .run(nonce);
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
    const row = this.db
      .prepare(`SELECT * FROM phone_enrollments WHERE token = ?`)
      .get(token) as PhoneEnrollmentRow | undefined;
    return row ?? null;
  }

  getPhoneEnrollmentByAttempt(attemptId: string): PhoneEnrollmentRow | null {
    const query = `SELECT * FROM integrity_phone_enrollments WHERE attempt_id = ? LIMIT 1`;
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
