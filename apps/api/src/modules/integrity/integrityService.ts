import { randomBytes } from 'node:crypto';

import { DomainError } from '@exam-anti-cheat/contracts';
import type { GeminiRotatingClient } from './gemini.js';
import type { IntegrityRepository } from './integrityRepository.js';
import {
  CHALLENGE_TYPES,
  generateChallenge,
  kindFromStoredType,
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
import { VIRTUAL_CAMERA_LABEL } from '@exam-anti-cheat/contracts/exam';
import type {
  AiCheckResult,
  AiCheckRunResponse,
  InstructorExamVersion,
  SimilarityRunResponse,
  TransparencyEvent,
} from '@exam-anti-cheat/contracts/exam';
import { friendlyVisionLabel } from './visionLabels.js';

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

export class LivenessRateLimitError extends Error {
  constructor() {
    super('Too many liveness checks requested. Wait a few minutes and try again.');
    this.name = 'LivenessRateLimitError';
  }
}

export const AI_CHECK_MAX_ANSWERS = 30;

export interface TelemetryCounts {
  readonly keystrokes: number;
  readonly gaze: number;
  readonly voice: number;
}

export class IntegrityService {
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
    // Transcript text older than this many days is deleted (AUDIO_RETAIN_DAYS).
    private readonly audioRetainDays: number = 30,
  ) {}

  private requireGemini(): GeminiRotatingClient {
    if (this.gemini === null) {
      throw new DomainError('invalid_state', 'AI checks need GEMINI_API_KEYS to be configured.');
    }
    return this.gemini;
  }

  // ── Liveness ─────────────────────────────────────────────────────────────────

  issueLivenessChallenge(attemptId: string, preferred?: unknown): GeneratedChallenge {
    const since = new Date(Date.now() - LIVENESS_CHALLENGE_WINDOW_MS).toISOString();
    if (this.repo.countLivenessChallengesSince(attemptId, since) >= LIVENESS_CHALLENGE_LIMIT) {
      throw new LivenessRateLimitError();
    }
    const type: ChallengeType = selectChallengeType(preferred);
    const challenge = generateChallenge(type);
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
      return scoreColourResponse(data.sequence as Colour[], payload.baseline, payload.frames);
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
    const qrData = `exam-anti-cheat://enroll?token=${token}&attemptId=${attemptId}`;
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

    const counts = { keystrokes: 0, gaze: 0, voice: 0 };
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
    for (const g of list(payload.gaze, 100)) {
      const at = timestamp(g.timestamp);
      const ms = duration(g.durationMs);
      if (at === null || ms === null || ms === 0) continue;
      this.repo.insertGazeEvent(attemptId, at, Math.max(1, Math.round(ms)));
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

  /** Deletes transcript text older than the retention window. Returns rows removed. */
  sweepExpiredTranscripts(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - this.audioRetainDays * 86_400_000);
    return this.repo.deleteAudioTranscriptsBefore(cutoff.toISOString());
  }

  getTranscript(attemptId: string): Array<{ capturedAt: string; text: string }> {
    this.sweepExpiredTranscripts();
    return this.repo
      .getAudioTranscripts(attemptId)
      .map((row) => ({ capturedAt: row.captured_at, text: row.text }));
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
