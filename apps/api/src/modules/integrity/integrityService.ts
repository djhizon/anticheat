import { randomBytes } from 'node:crypto';

import { DomainError } from '@exam-anti-cheat/contracts';
import type { GeminiRotatingClient } from './gemini.js';
import type { IntegrityRepository } from './integrityRepository.js';
import {
  generateChallenge,
  selectChallengeType,
  verifyFlashChallenge,
  verifyGestureChallenge,
  
  type ChallengeType,
  type GeneratedChallenge,
} from './liveness.js';
import { checkForAiGeneration, type AiCheckReport } from './aiCheck.js';
import { computeSimilarityReport, SIMILARITY_THRESHOLD } from './similarity.js';
import type {
  InstructorExamVersion,
  SimilarityRunResponse,
  TransparencyEvent,
} from '@exam-anti-cheat/contracts/exam';

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
        events.push({ timestamp: app.created_at, type: 'HARDWARE', severity: 'high', description: `Multiple displays detected (${app.display_count})` });
      } else if (app.foreground_app.startsWith('flag:vision_')) {
        events.push({ timestamp: app.created_at, type: 'VISION', severity: 'high', description: `Server vision detected: ${app.foreground_app.slice(12).replaceAll('_', ' ')}` });
      } else if (app.foreground_app.startsWith('flag:')) {
        events.push({ timestamp: app.created_at, type: 'SOFTWARE', severity: 'medium', description: `Flagged behaviour: ${app.foreground_app.slice(5).replaceAll('_', ' ')}` });
      } else if (app.foreground_app.startsWith('🎙️')) {
        events.push({ timestamp: app.created_at, type: 'AUDIO', severity: 'low', description: app.foreground_app.replace(/^🎙️\s*/u, '') });
      } else if (app.foreground_app && app.foreground_app !== 'unknown') {
        events.push({ timestamp: app.created_at, type: 'SOFTWARE', severity: 'medium', description: `Unauthorized app focused: ${app.foreground_app}` });
      }
    }
    
    for (const live of data.liveness) {
      let desc = 'Liveness check failed';
      try {
        const det = JSON.parse(live.details_json);
        if (det.detail) desc = det.detail;
        if (det.earbuds) desc = 'Earbuds detected by AI vision';
        if (det.phone === 'observed' || det.phone === 'candidate') desc = 'Mobile phone detected in frame';
      } catch (e) {}
      events.push({ timestamp: live.created_at, type: 'VISION', severity: 'high', description: desc });
    }
    
    for (const g of data.gaze) {
      events.push({ timestamp: g.created_at, type: 'GAZE', severity: 'low', description: `Looked away from screen for ${Math.round(g.duration_ms / 1000)}s` });
    }
    
    for (const v of data.voice) {
      events.push({ timestamp: v.created_at, type: 'AUDIO', severity: 'medium', description: `Speech detected for ${Math.round(v.duration_ms / 1000)}s` });
    }
    
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return events;
  }

  constructor(
    private readonly repo: IntegrityRepository,
    // Null when no GEMINI_API_KEYS are configured: monitoring still works,
    // only the Gemini-backed checks report that they are unavailable.
    private readonly gemini: GeminiRotatingClient | null,
  ) {}

  private requireGemini(): GeminiRotatingClient {
    if (this.gemini === null) {
      throw new DomainError('invalid_state', 'AI checks need GEMINI_API_KEYS to be configured.');
    }
    return this.gemini;
  }

  // ── Liveness ─────────────────────────────────────────────────────────────────

  issueLivenessChallenge(attemptId: string, attemptStartedAt: string): GeneratedChallenge {
    const type: ChallengeType = selectChallengeType(attemptStartedAt);
    const challenge = generateChallenge(type);
    this.repo.insertLivenessChallenge(
      challenge.nonce,
      attemptId,
      challenge.type,
      JSON.stringify(challenge.data),
      challenge.expiresAt,
    );
    return challenge;
  }

  async verifyLiveness(
    attemptId: string,
    nonce: string,
    layer: number,
    payload: Record<string, unknown>,
    imageBase64?: string,
  ): Promise<LivenessVerifyResponse> {
    const row = this.repo.getLivenessChallenge(nonce);
    if (!row || row.attempt_id !== attemptId || row.used) {
      return { passed: false, layer, detail: 'Challenge invalid or used' };
    }
    if (new Date(row.expires_at) < new Date()) {
      return { passed: false, layer, detail: 'Challenge expired' };
    }
    this.repo.markLivenessChallengeUsed(nonce);

    let result: { passed: boolean; detail: string };
    if (row.challenge_type === 'flash') {
      const brightnessDelta = Number(payload.brightnessDelta ?? 0);
      result = verifyFlashChallenge(brightnessDelta);
    } else if (row.challenge_type === 'gesture') {
      // TensorFlow's native runtime is expensive; load it only for a requested
      // gesture check, never on server startup or ordinary exam requests.
      try {
        const { verifyGestureLocally } = await import('./handDetector.js');
        const challengeData = JSON.parse(row.challenge_data) as { gesture: string };
        result = await verifyGestureLocally(imageBase64 || '', challengeData.gesture);
      } catch {
        // Preserve one-use challenges, but record an unavailable engine honestly
        // rather than losing the event or treating infrastructure failure as a pass.
        result = { passed: false, detail: 'Gesture engine unavailable. Check the local model installation and request a fresh challenge.' };
      }
    } else {
      result = { passed: false, detail: 'Unknown challenge type' };
    }

    this.repo.insertLivenessEvent(
      attemptId,
      layer,
      result.passed ? 'pass' : 'fail',
      nonce,
      JSON.stringify({ ...payload, detail: result.detail }),
    );

    return { passed: result.passed, layer, detail: result.detail };
  }

  // ── AI Check ─────────────────────────────────────────────────────────────────

  async runAiCheck(question: string, answer: string): Promise<AiCheckReport> {
    return checkForAiGeneration(this.requireGemini(), question, answer);
  }

  // ── Instructor: cross-student similarity ─────────────────────────────────────

  listInstructorVersions(): InstructorExamVersion[] {
    return this.repo.listVersionsWithTextQuestions();
  }

  async runSimilarity(examVersionId: string, questionId: string): Promise<SimilarityRunResponse> {
    const version = this.repo.listVersionsWithTextQuestions().find((candidate) => candidate.id === examVersionId);
    if (version === undefined || !version.questions.some((question) => question.id === questionId)) {
      throw new DomainError('not_found', 'The exam question was not found.');
    }
    const answers = this.repo.listTextAnswers(examVersionId, questionId);
    // Fewer than two answers needs no embeddings, so it works without Gemini keys too.
    const report =
      answers.length < 2
        ? { questionId, pairs: [], threshold: SIMILARITY_THRESHOLD, generatedAt: new Date().toISOString() }
        : await computeSimilarityReport(this.requireGemini(), questionId, answers);
    return { report, students: Object.fromEntries(answers.map((answer) => [answer.studentId, answer.email])) };
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
        ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).slice(0, max)
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
      const questionId = typeof k.questionId === 'string' && k.questionId !== '' ? k.questionId.slice(0, 128) : 'unknown';
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
      this.repo.insertVoiceEvent(attemptId, at, Math.max(1, Math.round(ms)), Number.isFinite(peak) ? peak : 0);
      counts.voice += 1;
    }
    return counts;
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
