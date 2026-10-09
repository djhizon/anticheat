import { randomBytes, randomUUID } from 'node:crypto';

import { DomainError } from '@examguard/contracts';
import type { GeminiRotatingClient } from './gemini.js';
import type {
  InputWindowRow,
  IntegrityRepository,
  RecordingSegmentRef,
} from './integrityRepository.js';
import { resolveExamPrivacy } from '../exam/examPrivacy.js';
import {
  CHALLENGE_TYPES,
  generateChallenge,
  kindFromStoredType,
  FLASH_THRESHOLDS,
  PULSE_THRESHOLDS,
  scoreColourResponse,
  selectChallengeType,
  signNonce,
  verifyHeadTurns,
  verifyNonceSignature,
  verifySpokenWords,
  type ChallengeType,
  type Colour,
  type GeneratedChallenge,
  type TurnDirection,
  type VerifyResult,
} from './liveness.js';
import { transcribeAudio } from './whisper.js';
import { checkForAiGeneration } from './aiCheck.js';
import { computeSimilarityReport, SIMILARITY_THRESHOLD } from './similarity.js';
import {
  EVIDENCE_MAX_PER_ATTEMPT,
  EVIDENCE_MIN_GAP_MS,
  REVIEWED_FINE_PURGE_DAYS,
  VIRTUAL_CAMERA_LABEL,
} from '@examguard/contracts/exam';
import type {
  InstructorAttemptSummary,
  IntegrityTimelineEntry,
  IntegrityTimelineSource,
  AiCheckResult,
  AiCheckRunResponse,
  EvidenceSnapshotMeta,
  EvidenceSource,
  StoredEvidenceSource,
  EvidenceTrigger,
  InstructorExamVersion,
  SimilarityRunResponse,
  TransparencyEvent,
} from '@examguard/contracts/exam';
import type { AttemptFindings } from '@examguard/contracts/findings';
import { friendlyVisionLabel } from './visionLabels.js';
import { buildTimeline } from './timeline.js';
import { buildFindings } from './findings.js';

/** Findings are recomputed from the timeline at most this often per attempt. */
export const FINDINGS_CACHE_MS = 30_000;

/** Student-facing text for the on-device wearables check (glasses and watches are ordinary). */
const LOCAL_VISION_TEXT: Readonly<Record<string, readonly ['low' | 'medium', string]>> = {
  'flag:earbuds_detected': ['medium', 'On-device camera check: possible earbuds (a lead only)'],
  'flag:headphones_detected': [
    'medium',
    'On-device camera check: possible headphones (a lead only)',
  ],
  'flag:glasses_detected': ['low', 'Glasses worn (normal, information only)'],
  'flag:watch_detected': ['low', 'A wristwatch was visible (information only)'],
  'flag:phone_detected_detailed': ['medium', 'On-device camera check: possible phone in view'],
  'flag:notes_detected': ['medium', 'On-device camera check: possible paper notes in view'],
  'flag:extra_person_detected': ['medium', 'On-device camera check: possibly a second person'],
};

const GAZE_DIRECTIONS = new Set([
  'left',
  'right',
  'up',
  'down',
  'away',
  'no_face',
  'multiple_faces',
]);

export interface LivenessVerifyResponse {
  readonly passed: boolean;
  readonly layer: number;
  readonly detail: string;
}

export interface PhoneEnrollResponse {
  readonly token: string;
  readonly qrData: string;
  readonly expiresAt: string;
}

/** Layers recorded in liveness_events (CHECK layer BETWEEN 1 AND 4). */
export const LIVENESS_LAYERS = [1, 2, 3, 4] as const;
export const LIVENESS_CHALLENGE_LIMIT = 6;
export const LIVENESS_CHALLENGE_WINDOW_MS = 10 * 60_000;

/** Thrown when a Gemini-backed check runs on a server without GEMINI_API_KEYS. */
export class GeminiUnavailableError extends DomainError {
  constructor() {
    super('invalid_state', 'AI checks need GEMINI_API_KEYS to be configured.');
    this.name = 'GeminiUnavailableError';
  }
}

export class LivenessRateLimitError extends Error {
  constructor() {
    super('Too many liveness checks requested. Wait a few minutes and try again.');
    this.name = 'LivenessRateLimitError';
  }
}

export class EvidenceRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceRateLimitError';
  }
}

export const AI_CHECK_MAX_ANSWERS = 30;

export interface TelemetryCounts {
  readonly keystrokes: number;
  readonly input: number;
  readonly gaze: number;
  readonly voice: number;
}

/** Plain-language student report lines for routine (non-accusatory) events. */
const TRANSPARENCY_NOTES: Readonly<Record<string, string>> = {
  'flag:presence_check_passed': 'A quick presence check passed',
  'flag:presence_check_failed':
    'A quick presence check could not confirm you after a retry; an instructor may review (not a verdict)',
  'flag:screen_recording_stopped': 'Screen recording stopped and answering paused until it resumed',
  'flag:screen_recording_resumed': 'Screen recording resumed',
  'flag:recording_started': 'Screen recording started',
  'flag:recording_stopped': 'Screen recording stopped at the end of the exam',
};

export class IntegrityService {
  private readonly findingsCache = new Map<string, { at: number; value: AttemptFindings }>();

  async getTransparencyReport(attemptId: string): Promise<TransparencyEvent[]> {
    const data = this.repo.getTransparencyEvents(attemptId);

    const events: TransparencyEvent[] = [];

    for (const app of data.apps) {
      if (app.display_count > 1) {
        events.push({
          timestamp: app.created_at,
          type: 'HARDWARE',
          severity: 'high',
          description: `Multiple displays detected (${app.display_count})`,
        });
      } else if (app.foreground_app.startsWith('flag:vision_')) {
        events.push({
          timestamp: app.created_at,
          type: 'VISION',
          // Zero-shot detection of small wearables misses and misreads often: a lead, not proof.
          severity: 'medium',
          description: `Server vision (OWL-ViT) possibly saw: ${friendlyVisionLabel(app.foreground_app.slice(12))}`,
        });
      } else if (app.foreground_app.startsWith('flag:lighting_poor')) {
        events.push({
          timestamp: app.created_at,
          type: 'HARDWARE',
          severity: 'low',
          description: 'Camera lighting was poor for a while (face tracking may be less reliable)',
        });
      } else if (LOCAL_VISION_TEXT[app.foreground_app] !== undefined) {
        const [severity, description] = LOCAL_VISION_TEXT[app.foreground_app]!;
        events.push({ timestamp: app.created_at, type: 'VISION', severity, description });
      } else if (app.foreground_app === 'flag:brightness_restored') {
        events.push({
          timestamp: app.created_at,
          type: 'HARDWARE',
          severity: 'low',
          description: 'Screen brightness was lowered and the app restored it to maximum',
        });
      } else if (TRANSPARENCY_NOTES[app.foreground_app] !== undefined) {
        events.push({
          timestamp: app.created_at,
          type: 'HARDWARE',
          severity: 'low',
          description: TRANSPARENCY_NOTES[app.foreground_app]!,
        });
      } else if (app.foreground_app === 'flag:liveness_unverified') {
        events.push({
          timestamp: app.created_at,
          type: 'HARDWARE',
          severity: 'low',
          description:
            'The presence check could not be completed after several tries; the student continued and an instructor may review',
        });
      } else if (app.foreground_app.startsWith('flag:')) {
        events.push({
          timestamp: app.created_at,
          type: 'SOFTWARE',
          severity: 'medium',
          description: `Flagged behaviour: ${app.foreground_app.slice(5).replaceAll('_', ' ')}`,
        });
      } else if (app.foreground_app && app.foreground_app !== 'unknown') {
        events.push({
          timestamp: app.created_at,
          type: 'SOFTWARE',
          severity: 'medium',
          description: `Unauthorized app focused: ${app.foreground_app}`,
        });
      }
    }

    for (const live of data.liveness) {
      let desc = 'Liveness check failed';
      try {
        const det = JSON.parse(live.details_json);
        if (det.detail) desc = det.detail;
        if (det.earbuds) desc = 'Earbuds detected by AI vision';
        if (det.phone === 'observed' || det.phone === 'candidate')
          desc = 'Mobile phone detected in frame';
      } catch (e) {}
      events.push({
        timestamp: live.created_at,
        type: 'VISION',
        severity: 'high',
        description: desc,
      });
    }

    for (const g of data.gaze) {
      events.push({
        timestamp: g.created_at,
        type: 'GAZE',
        severity: 'low',
        description: `Looked away from screen for ${Math.round(g.duration_ms / 1000)}s`,
      });
    }

    for (const v of data.voice) {
      events.push({
        timestamp: v.created_at,
        type: 'AUDIO',
        severity: 'medium',
        description: `Speech detected for ${Math.round(v.duration_ms / 1000)}s`,
      });
    }

    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return events;
  }

  constructor(
    private readonly repo: IntegrityRepository,
    // Null when no GEMINI_API_KEYS are configured: monitoring still works,
    // only the Gemini-backed checks report that they are unavailable.
    private readonly gemini: GeminiRotatingClient | null,
    // Signs liveness challenges. A per-process random secret is fine because
    // challenges expire in 90s; set LIVENESS_SECRET to survive restarts.
    private readonly livenessSecret: string = process.env.LIVENESS_SECRET ||
      randomBytes(32).toString('hex'),
    // Default transcript retention (AUDIO_RETAIN_DAYS) for exams without their own setting.
    private readonly audioRetainDays: number = 30,
    // Default evidence/recording-metadata retention (EVIDENCE_RETAIN_DAYS); 0 keeps them.
    private readonly evidenceRetainDays: number = 30,
    // Default for exams without a recording-upload choice (RECORDING_UPLOAD).
    private readonly recordingUploadDefault: boolean = true,
    // Best-effort removal of uploaded segments (OneDrive) once their metadata is swept.
    private readonly remoteRecordingDeleter:
      ((segments: readonly RecordingSegmentRef[]) => Promise<void>) | null = null,
  ) {}

  /** Whether the Gemini-backed instructor checks can run on this server. */
  get geminiAvailable(): boolean {
    return this.gemini !== null;
  }

  private requireGemini(): GeminiRotatingClient {
    if (this.gemini === null) {
      throw new GeminiUnavailableError();
    }
    return this.gemini;
  }

  // ── Liveness ─────────────────────────────────────────────────────────────────

  /**
   * `purpose: 'spot_check'` issues the mid-exam colour-reflection pulse (always colour, signed
   * `mode: 'pulse'`); otherwise the setup check (colour, or spoken words on request).
   */
  issueLivenessChallenge(
    attemptId: string,
    preferred?: unknown,
    purpose?: unknown,
  ): GeneratedChallenge {
    const since = new Date(Date.now() - LIVENESS_CHALLENGE_WINDOW_MS).toISOString();
    if (this.repo.countLivenessChallengesSince(attemptId, since) >= LIVENESS_CHALLENGE_LIMIT) {
      throw new LivenessRateLimitError();
    }
    const spotCheck = purpose === 'spot_check';
    const type: ChallengeType = spotCheck ? 'colour_flash' : selectChallengeType(preferred);
    const challenge = generateChallenge(type, { pulse: spotCheck });
    const data = JSON.stringify(challenge.data);
    this.repo.insertLivenessChallenge(challenge.nonce, attemptId, type, data, challenge.expiresAt);
    const signature = signNonce({ attemptId, ...challenge, data }, this.livenessSecret);
    return { ...challenge, signature };
  }

  private async scoreLiveness(
    kind: ChallengeType,
    data: Record<string, unknown>,
    payload: Record<string, unknown>,
    audioBase64?: string,
  ): Promise<VerifyResult> {
    if (kind === 'colour_flash') {
      return scoreColourResponse(
        data.sequence as Colour[],
        payload.baseline,
        payload.frames,
        payload.faces,
        data.mode === 'pulse' ? PULSE_THRESHOLDS : FLASH_THRESHOLDS,
      );
    }
    if (kind === 'head_turn') {
      return verifyHeadTurns(data.sequence as TurnDirection[], payload.samples);
    }
    // spoken_words: transcribed on this machine; audio is never stored or sent out.
    try {
      const buffer = Buffer.from(audioBase64 ?? '', 'base64');
      const transcript = await transcribeAudio(buffer);
      return verifySpokenWords(data.words as string[], transcript);
    } catch {
      return {
        passed: false,
        detail: 'Speech could not be transcribed. Check the microphone and retry.',
      };
    }
  }

  async verifyLiveness(
    attemptId: string,
    nonce: string,
    layer: number,
    payload: Record<string, unknown>,
    signature?: unknown,
    cameraLabel?: string,
    audioBase64?: string,
  ): Promise<LivenessVerifyResponse> {
    if (!(LIVENESS_LAYERS as readonly number[]).includes(layer)) {
      throw new DomainError('validation_failed', 'Unsupported liveness layer');
    }
    const row = this.repo.getLivenessChallenge(nonce);
    if (!row || row.attempt_id !== attemptId || row.used) {
      return { passed: false, layer, detail: 'Challenge invalid or used' };
    }
    // The signature covers type and data (sequence/words) as stored, and is
    // checked before the challenge is consumed so forgeries never burn one.
    const signed = {
      attemptId,
      nonce,
      type: this.kindOf(row.challenge_data, row.challenge_type),
      expiresAt: row.expires_at,
      data: row.challenge_data,
    };
    if (!verifyNonceSignature(signed, signature, this.livenessSecret)) {
      return { passed: false, layer, detail: 'Challenge signature invalid' };
    }
    if (new Date(row.expires_at) < new Date()) {
      return { passed: false, layer, detail: 'Challenge expired' };
    }
    this.repo.markLivenessChallengeUsed(nonce);

    let result: VerifyResult;
    const kind = this.kindOf(row.challenge_data, row.challenge_type);
    if (!cameraLabel || VIRTUAL_CAMERA_LABEL.test(cameraLabel)) {
      // Only a native hardware webcam counts; OBS and other virtual feeds fail.
      result = {
        passed: false,
        detail: cameraLabel
          ? `Virtual camera "${cameraLabel.slice(0, 60)}" is not allowed. Use the built-in webcam.`
          : 'No native camera was identified. Use the built-in webcam.',
      };
    } else if ((CHALLENGE_TYPES as readonly string[]).includes(kind)) {
      result = await this.scoreLiveness(
        kind as ChallengeType,
        JSON.parse(row.challenge_data) as Record<string, unknown>,
        payload,
        audioBase64,
      );
    } else {
      result = { passed: false, detail: 'Unknown challenge type' };
    }

    if (this.isPulse(row.challenge_data)) {
      // Mid-exam spot check: a server-verified pass is logged as such; a miss is retried by the
      // client and only reported (non-accusatory) after the retry also missed.
      if (result.passed) this.recordAppEvent(attemptId, 'flag:presence_check_passed', 1);
      return { passed: result.passed, layer, detail: result.detail };
    }

    this.repo.insertLivenessEvent(
      attemptId,
      layer,
      result.passed ? 'pass' : 'fail',
      nonce,
      JSON.stringify({
        kind,
        camera: cameraLabel ?? null,
        detail: result.detail,
      }),
    );

    return { passed: result.passed, layer, detail: result.detail };
  }

  private isPulse(challengeData: string): boolean {
    try {
      return (JSON.parse(challengeData) as { mode?: unknown }).mode === 'pulse';
    } catch {
      return false;
    }
  }

  private kindOf(challengeData: string, storedType: string): string {
    try {
      const parsed = JSON.parse(challengeData) as { kind?: unknown };
      if (typeof parsed.kind === 'string') {
        return parsed.kind;
      }
    } catch {
      // fall through to the stored column
    }
    return kindFromStoredType(storedType) ?? 'unknown';
  }

  // ── AI Check ─────────────────────────────────────────────────────────────────

  // ── Instructor: cross-student similarity ─────────────────────────────────────

  listInstructorVersions(): InstructorExamVersion[] {
    return this.repo.listVersionsWithTextQuestions();
  }

  private requireTextQuestion(examVersionId: string, questionId: string) {
    const question = this.repo
      .listVersionsWithTextQuestions()
      .find((candidate) => candidate.id === examVersionId)
      ?.questions.find((candidate) => candidate.id === questionId);
    if (question === undefined) {
      throw new DomainError('not_found', 'The exam question was not found.');
    }
    return question;
  }

  async runSimilarity(examVersionId: string, questionId: string): Promise<SimilarityRunResponse> {
    this.requireTextQuestion(examVersionId, questionId);
    const answers = this.repo.listTextAnswers(examVersionId, questionId);
    // Fewer than two answers needs no embeddings, so it works without Gemini keys too.
    const report =
      answers.length < 2
        ? {
            questionId,
            pairs: [],
            threshold: SIMILARITY_THRESHOLD,
            generatedAt: new Date().toISOString(),
          }
        : await computeSimilarityReport(this.requireGemini(), questionId, answers);
    return {
      report,
      students: Object.fromEntries(answers.map((answer) => [answer.studentId, answer.email])),
    };
  }

  /**
   * Instructor-only: ask Gemini whether each student's saved answer to one
   * question reads as AI-generated. Sequential and capped to stay inside the
   * Gemini rate limits; results are leads for review, never penalties.
   */
  async runAiCheckForQuestion(
    examVersionId: string,
    questionId: string,
    limit = AI_CHECK_MAX_ANSWERS,
  ): Promise<AiCheckRunResponse> {
    const question = this.requireTextQuestion(examVersionId, questionId);
    const answers = this.repo.listTextAnswers(examVersionId, questionId);
    const checkedAt = new Date().toISOString();
    if (answers.length === 0) return { questionId, checkedAt, results: [], truncated: false };
    const gemini = this.requireGemini();
    // Three at a time: ~3x faster than sequential while staying gentle on rate limits.
    const queue = answers.slice(0, limit);
    const results: AiCheckResult[] = [];
    const worker = async () => {
      for (let answer = queue.shift(); answer; answer = queue.shift()) {
        const report = await checkForAiGeneration(gemini, question.prompt, answer.text);
        results.push({
          studentId: answer.studentId,
          email: answer.email,
          score: report.score,
          flags: report.flags,
          summary: report.summary,
          available: report.available,
        });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    results.sort((a, b) => b.score - a.score);
    return { questionId, checkedAt, results, truncated: answers.length > limit };
  }

  // ── Phone Enrollment ─────────────────────────────────────────────────────────

  enrollPhone(attemptId: string): PhoneEnrollResponse {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8h
    this.repo.insertPhoneEnrollment(attemptId, token);
    // QR data encodes a deep-link that the exam mobile companion app would open
    const qrData = `examguard://enroll?token=${token}&attemptId=${attemptId}`;
    return { token, qrData, expiresAt };
  }

  phoneHeartbeat(token: string): { ok: boolean; attemptId: string | null } {
    const row = this.repo.getPhoneEnrollmentByToken(token);
    if (row === null) return { ok: false, attemptId: null };
    this.repo.updatePhoneHeartbeat(token, new Date().toISOString());
    return { ok: true, attemptId: row.attempt_id };
  }

  checkPhoneStatus(attemptId: string): { active: boolean } {
    const row = this.repo.getPhoneEnrollmentByAttempt(attemptId);
    if (!row || !row.last_seen_at) return { active: false };
    const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
    return { active: ageMs < 10000 };
  }

  // ── Native Companion ─────────────────────────────────────────────────────────

  /**
   * Store one telemetry batch from the browser. Every field is validated and
   * each list is capped, so malformed or oversized uploads cannot hit the
   * database CHECK constraints or flood the tables.
   */
  recordTelemetry(attemptId: string, payload: Record<string, unknown>): TelemetryCounts {
    const list = (value: unknown, max: number): Record<string, unknown>[] =>
      Array.isArray(value)
        ? value
            .filter(
              (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
            )
            .slice(0, max)
        : [];
    const duration = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 24 * 60 * 60 * 1000 ? n : null;
    };
    const timestamp = (value: unknown): string | null => {
      const date = new Date(typeof value === 'number' || typeof value === 'string' ? value : NaN);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };

    const counts = { keystrokes: 0, gaze: 0, voice: 0, input: 0 };
    for (const k of list(payload.keystrokes, 500)) {
      const dwell = duration(k.dwellMs);
      const flight = duration(k.flightMs);
      if (dwell === null || flight === null) continue;
      const questionId =
        typeof k.questionId === 'string' && k.questionId !== ''
          ? k.questionId.slice(0, 128)
          : 'unknown';
      this.repo.insertKeystrokeEvent(attemptId, questionId, dwell, flight);
      counts.keystrokes += 1;
    }
    for (const w of list(payload.input, 20)) {
      const row = parseInputWindow(w);
      if (row === null) continue;
      this.repo.insertInputWindow(attemptId, row);
      counts.input += 1;
    }
    for (const g of list(payload.gaze, 100)) {
      const at = timestamp(g.timestamp);
      const ms = duration(g.durationMs);
      if (at === null || ms === null || ms === 0) continue;
      const direction = GAZE_DIRECTIONS.has(String(g.direction)) ? String(g.direction) : 'away';
      const degrees = (value: unknown): number | null => {
        const n = Number(value);
        return value !== null && value !== undefined && Number.isFinite(n) && Math.abs(n) <= 360
          ? Math.round(n)
          : null;
      };
      this.repo.insertGazeEvent(
        attemptId,
        at,
        Math.max(1, Math.round(ms)),
        direction,
        degrees(g.yaw),
        degrees(g.pitch),
      );
      counts.gaze += 1;
    }
    for (const v of list(payload.voice, 100)) {
      const at = timestamp(v.timestamp);
      const ms = duration(v.durationMs);
      if (at === null || ms === null || ms === 0) continue;
      const peak = Number(v.peakDb);
      this.repo.insertVoiceEvent(
        attemptId,
        at,
        Math.max(1, Math.round(ms)),
        Number.isFinite(peak) ? peak : 0,
      );
      counts.voice += 1;
    }
    return counts;
  }

  /** Stores transcript text only. The report lists it once, via getTranscript. */
  recordTranscript(attemptId: string, text: string, capturedAt: Date = new Date()): void {
    const clean = text.trim().slice(0, 2000);
    if (clean === '') return;
    this.repo.insertAudioTranscript(attemptId, capturedAt.toISOString(), clean);
  }

  /** Deletes transcript text older than each exam's retention window. Returns rows removed. */
  sweepExpiredTranscripts(now: Date = new Date()): number {
    return this.repo.deleteExpiredAudioTranscripts(now.toISOString(), this.audioRetainDays);
  }

  // ── Screen recording metadata ────────────────────────────────────────────────

  /** Remembers one uploaded segment so retention and "marked fine" sweeps can remove it later. */
  recordRecordingSegment(
    attemptId: string,
    studentId: string,
    segmentIndex: number,
    bytes: number,
    now: Date = new Date(),
  ): void {
    this.repo.insertRecordingSegment(attemptId, studentId, segmentIndex, bytes, now.toISOString());
  }

  /** Forgets uploaded-segment metadata past retention and asks OneDrive to drop the files. */
  sweepExpiredRecordings(now: Date = new Date()): number {
    const removed = this.repo.deleteExpiredRecordingSegments(
      now.toISOString(),
      this.evidenceRetainDays,
    );
    this.forgetRemoteSegments(removed);
    return removed.length;
  }

  private forgetRemoteSegments(segments: readonly RecordingSegmentRef[]): void {
    if (segments.length === 0 || this.remoteRecordingDeleter === null) return;
    void this.remoteRecordingDeleter(segments).catch(() => {
      console.warn('[retention] could not remove uploaded recording segments');
    });
  }

  /**
   * Deletes photos, transcripts and recording metadata of attempts a teacher marked "fine" more
   * than 7 days ago. Findings and timeline rows stay. No-op until the review_decisions table
   * exists. Returns the number of attempts purged.
   */
  sweepReviewedFine(now: Date = new Date()): number {
    if (!this.repo.hasReviewDecisions()) return 0;
    const cutoff = new Date(now.getTime() - REVIEWED_FINE_PURGE_DAYS * 86_400_000);
    const attemptIds = this.repo.listAttemptsMarkedFineBefore(cutoff.toISOString());
    if (attemptIds.length === 0) return 0;
    const result = this.repo.purgeAttemptMedia(attemptIds);
    this.forgetRemoteSegments(result.segments);
    return attemptIds.length;
  }

  /** Runs every retention sweep (server start, daily). */
  sweepRetention(now: Date = new Date()): {
    transcripts: number;
    evidence: number;
    recordings: number;
    reviewedFine: number;
  } {
    return {
      transcripts: this.sweepExpiredTranscripts(now),
      evidence: this.sweepExpiredEvidence(now),
      recordings: this.sweepExpiredRecordings(now),
      reviewedFine: this.sweepReviewedFine(now),
    };
  }

  // ── Evidence snapshots ───────────────────────────────────────────────────────

  /**
   * Stores one validated JPEG. Enforces at most one per (attempt, source, trigger)
   * per 30 s and 60 per attempt; throws EvidenceRateLimitError past either limit.
   */
  recordEvidence(input: {
    readonly attemptId: string;
    readonly source: EvidenceSource;
    readonly trigger: EvidenceTrigger;
    readonly capturedAt: Date;
    readonly bytes: Buffer;
    readonly now?: Date;
  }): string {
    const now = input.now ?? new Date();
    this.sweepExpiredEvidence(now);
    if (this.repo.countEvidence(input.attemptId) >= EVIDENCE_MAX_PER_ATTEMPT) {
      throw new EvidenceRateLimitError('The evidence limit for this attempt is reached.');
    }
    const since = new Date(now.getTime() - EVIDENCE_MIN_GAP_MS).toISOString();
    if (this.repo.countEvidenceSince(input.attemptId, input.source, input.trigger, since) > 0) {
      throw new EvidenceRateLimitError('An evidence snapshot for this trigger was just saved.');
    }
    const id = randomUUID();
    this.repo.insertEvidence({
      id,
      attemptId: input.attemptId,
      source: input.source,
      trigger: input.trigger,
      capturedAt: input.capturedAt.toISOString(),
      createdAt: now.toISOString(),
      bytes: input.bytes,
    });
    return id;
  }

  /** Deletes evidence older than each exam's retention window (0 days keeps everything). */
  sweepExpiredEvidence(now: Date = new Date()): number {
    return this.repo.deleteExpiredEvidence(now.toISOString(), this.evidenceRetainDays);
  }

  listEvidence(attemptId: string): EvidenceSnapshotMeta[] {
    this.sweepExpiredEvidence();
    return this.repo.listEvidence(attemptId).map((row) => ({
      id: row.id,
      source: row.source as StoredEvidenceSource,
      trigger: row.trigger as EvidenceTrigger,
      capturedAt: row.captured_at,
    }));
  }

  getEvidenceImage(attemptId: string, id: string): { mime: string; bytes: Buffer } | null {
    this.sweepExpiredEvidence();
    const row = this.repo.getEvidence(attemptId, id);
    return row ? { mime: row.mime, bytes: Buffer.from(row.bytes) } : null;
  }

  getTranscript(attemptId: string): Array<{ capturedAt: string; text: string }> {
    this.sweepExpiredTranscripts();
    return this.repo
      .getAudioTranscripts(attemptId)
      .map((row) => ({ capturedAt: row.captured_at, text: row.text }));
  }

  /** Unified, chronological integrity log for one attempt (null when it does not exist). */
  getTimeline(
    attemptId: string,
    sources?: ReadonlySet<IntegrityTimelineSource>,
  ): IntegrityTimelineEntry[] | null {
    const meta = this.repo.getAttemptTimelineMeta(attemptId);
    if (meta === null) return null;
    this.sweepExpiredTranscripts();
    this.sweepExpiredEvidence();
    const entries = buildTimeline(this.repo.getTimelineRows(attemptId, meta));
    return sources === undefined ? entries : entries.filter((e) => sources.has(e.source));
  }

  /**
   * Triage findings for one attempt (null when it does not exist). Computed from the stored
   * timeline and cached for FINDINGS_CACHE_MS so list views and polling stay cheap.
   */
  getFindings(attemptId: string, now: number = Date.now()): AttemptFindings | null {
    const cached = this.findingsCache.get(attemptId);
    if (cached !== undefined && now - cached.at < FINDINGS_CACHE_MS) return cached.value;
    const meta = this.repo.getAttemptTimelineMeta(attemptId);
    if (meta === null) {
      this.findingsCache.delete(attemptId);
      return null;
    }
    const built = buildFindings(this.repo.getTimelineRows(attemptId, meta));
    const notes = this.repo.getFindingNotes(attemptId);
    const value: AttemptFindings =
      notes.size === 0
        ? built
        : {
            ...built,
            findings: built.findings.map((f) => ({
              ...f,
              studentNote: notes.get(f.id) ?? null,
            })),
          };
    this.findingsCache.set(attemptId, { at: now, value });
    return value;
  }

  listAttemptsForInstructor(): InstructorAttemptSummary[] {
    return this.repo.listAttemptsForInstructor().map((row) => {
      const findings = this.getFindings(row.id);
      return {
        id: row.id,
        studentEmail: row.student_email,
        examTitle: row.exam_title,
        status: row.status,
        startedAt: row.started_at,
        level: findings?.level ?? 'none',
        topReason: findings?.topReason ?? null,
        findingCount: findings?.findings.length ?? 0,
        privacy: resolveExamPrivacy(
          { retainDays: row.retain_days, recordingUpload: row.recording_upload },
          {
            audioRetainDays: this.audioRetainDays,
            evidenceRetainDays: this.evidenceRetainDays,
            recordingUpload: this.recordingUploadDefault,
          },
        ),
      };
    });
  }

  recordAppEvent(attemptId: string, foregroundApp: string, displayCount: number): void {
    this.repo.insertAppEvent(attemptId, foregroundApp, displayCount);
  }

  // ── Audio ────────────────────────────────────────────────────────────────────

  saveAudio(attemptId: string, buffer: Buffer, durationMs: number): string {
    return this.repo.saveAudioBlob(attemptId, buffer, durationMs);
  }

  // ── Answer Revisions ─────────────────────────────────────────────────────────

  recordAnswerRevision(attemptId: string, questionVersionId: string, valueText: string): void {
    this.repo.insertAnswerRevision(attemptId, questionVersionId, valueText);
  }

  getRevisions(
    attemptId: string,
    questionVersionId: string,
  ): ReadonlyArray<{ value_text: string; created_at: string; word_count: number }> {
    return this.repo.getAnswerRevisions(attemptId, questionVersionId);
  }
}

const EDGES = new Set(['left', 'right', 'top', 'bottom']);

/**
 * Validate one aggregated input window from the browser. Counts are clamped to
 * sane ranges; a window with an unusable start or length is dropped.
 */
function parseInputWindow(w: Record<string, unknown>): InputWindowRow | null {
  const start = new Date(typeof w.windowStart === 'number' ? w.windowStart : NaN);
  const length = Number(w.windowMs);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(length) || length <= 0) return null;
  const count = (value: unknown, max = 100_000): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0;
  };
  const real = (value: unknown, max: number): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= -max && n <= max ? Math.round(n * 1000) / 1000 : null;
  };
  const windowMs = Math.min(Math.round(length), 10 * 60_000);
  return {
    window_start: start.toISOString(),
    window_ms: Math.max(1, windowMs),
    pointer_events: count(w.pointerEvents),
    pointer_leaves: count(w.pointerLeaves, 10_000),
    pointer_outside_ms: Math.min(count(w.pointerOutsideMs, 3_600_000), windowMs),
    longest_outside_ms: Math.min(count(w.longestOutsideMs, 3_600_000), windowMs),
    outside_edge:
      typeof w.outsideEdge === 'string' && EDGES.has(w.outsideEdge) ? w.outsideEdge : null,
    untrusted_events: count(w.untrustedEvents),
    teleports: count(w.teleports),
    robotic_segments: count(w.roboticSegments),
    path_straightness: real(w.pathStraightness, 1),
    velocity_cv: real(w.velocityCv, 1000),
    context_menus: count(w.contextMenus),
    selections: count(w.selections),
    keys: count(w.keys),
    chars: count(w.chars),
    corrections: count(w.corrections),
    mean_dwell_ms: real(w.meanDwellMs, 60_000),
    mean_interval_ms: real(w.meanIntervalMs, 60_000),
    interval_cv: real(w.intervalCv, 1000),
    wpm: real(w.wpm, 5000),
    injections: count(w.injections, 10_000),
    idle_pointer_injections: count(w.idlePointerInjections, 10_000),
    drift_z_dwell: real(w.driftZDwell, 100_000),
    drift_z_interval: real(w.driftZInterval, 100_000),
  };
}
