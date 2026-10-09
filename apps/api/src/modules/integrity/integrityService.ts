import { randomBytes } from 'node:crypto';
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

export class IntegrityService {
  async getTransparencyReport(attemptId: string) {
    const data = this.repo.getTransparencyEvents(attemptId);
    
    const events: Array<{ timestamp: string; type: string; description: string; severity: 'low'|'medium'|'high' }> = [];
    
    for (const app of data.apps) {
      if (app.display_count > 1) {
        events.push({ timestamp: app.created_at, type: 'HARDWARE', severity: 'high', description: `Multiple displays detected (${app.display_count})` });
      } else if (app.foreground_app) {
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
    private readonly gemini: GeminiRotatingClient,
  ) {}

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
    return checkForAiGeneration(this.gemini, question, answer);
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

  
  recordTelemetry(attemptId: string, payload: any): void {
    if (payload.gaze && Array.isArray(payload.gaze)) {
      for (const g of payload.gaze) {
        this.repo.insertGazeEvent(attemptId, new Date(g.timestamp).toISOString(), Number(g.durationMs));
      }
    }
    if (payload.keystrokes && Array.isArray(payload.keystrokes)) {
      for (const k of payload.keystrokes) {
        this.repo.insertKeystrokeEvent(attemptId, k.questionId || 'unknown', Number(k.dwellMs), Number(k.flightMs));
      }
    }
    if (payload.voice && Array.isArray(payload.voice)) {
      for (const v of payload.voice) {
        this.repo.insertVoiceEvent(attemptId, new Date(v.timestamp).toISOString(), Number(v.durationMs), Number(v.peakDb || 0));
      }
    }
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
