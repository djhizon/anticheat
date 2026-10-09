import {
  DomainError,
  problemFromError,
  type AttemptId,
  type Opaque,
  type ProblemCode,
} from '@exam-anti-cheat/contracts';

import type { ApiConfig } from '../../config.js';
import type {
  AssignmentId,
  ExamAnswerSaveRequest,
  ExamSubmitRequest,
} from '@exam-anti-cheat/contracts/exam';
import { headerValue, type AuthRequest, type AuthRequestBoundary } from '../auth/auth.plugin.js';
import { isAllowedOrigin } from '../auth/csrf.js';
import { ExamService } from './exam.service.js';
import type { IntegrityService } from '../integrity/integrityService.js';
import { isRecordingUploadConfigured, uploadRecordingChunk } from '../integrity/graph.js';
import type { PhonePresenceService } from '../integrity/phonePresence.js';
import type { VisionResult } from '../integrity/backendVision.js';

export type ExamResponseHeaderValue = string | readonly string[];

export interface ExamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, ExamResponseHeaderValue>>;
  readonly body: unknown;
}

const corsAllowedMethods = 'GET, POST, PUT, PATCH, OPTIONS';
const corsAllowedHeaders = 'Content-Type, X-CSRF-Token';
const corsRequestMethods = new Set(['GET', 'POST', 'PUT', 'PATCH']);
const corsRequestHeaders = new Set(['content-type', 'x-csrf-token']);
const assignmentStartPattern = /^\/exam\/assignments\/([^/]+)\/start$/u;
const attemptPattern = /^\/exam\/attempts\/([^/]+)$/u;
const answersPattern = /^\/exam\/attempts\/([^/]+)\/answers$/u;
const submitPattern = /^\/exam\/attempts\/([^/]+)\/submit$/u;
// Pack 8: integrity routes
const audioPattern = /^\/exam\/attempts\/([^/]+)\/audio$/u;
const livChallengePattern = /^\/exam\/attempts\/([^/]+)\/liveness-challenge$/u;
const livVerifyPattern = /^\/exam\/attempts\/([^/]+)\/liveness-verify$/u;
const eventsPattern = /^\/exam\/attempts\/([^/]+)\/events$/u;
const visionPattern = /^\/exam\/attempts\/([^/]+)\/vision-check$/u;
const telemetryPattern = /^\/exam\/attempts\/([^/]+)\/telemetry$/u;
const transpPattern = /^\/exam\/attempts\/([^/]+)\/transparency$/u;
const enrollPhonePattern = /^\/exam\/attempts\/([^/]+)\/enroll-phone$/u;
const phoneStatusPattern = /^\/exam\/attempts\/([^/]+)\/phone-status$/u;
const revisionsPattern = /^\/exam\/attempts\/([^/]+)\/revisions$/u;
/** Segments are ~10 s; 4M base64 chars (~3 MB) is far above the highest profile and below the server body cap. */
const MAX_RECORDING_BASE64_CHARS = 4_000_000;
const MAX_RECORDING_INDEX = 100_000;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u;
const recordingPattern = /^\/exam\/attempts\/([^/]+)\/recording$/u;
const speedtestPattern = /^\/exam\/speedtest$/u;
const phonePresencePattern = /^\/exam\/attempts\/([^/]+)\/phone-presence$/u;
const instructorVersionsPath = '/exam/instructor/versions';
const instructorAiCheckPattern =
  /^\/exam\/instructor\/versions\/([^/]+)\/questions\/([^/]+)\/ai-check$/u;
const similarityPattern =
  /^\/exam\/instructor\/versions\/([^/]+)\/questions\/([^/]+)\/similarity$/u;

const problemStatus: Record<ProblemCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  invalid_state: 500,
};

function corsHeaders(
  request: AuthRequest,
  allowedOrigins: readonly string[],
): Readonly<Record<string, ExamResponseHeaderValue>> {
  const headers: Record<string, ExamResponseHeaderValue> = { vary: 'Origin' };
  const origin = headerValue(request.headers, 'origin');

  if (origin !== undefined && isAllowedOrigin(origin, allowedOrigins)) {
    // Credentialed responses echo only a configured origin; wildcard credentials are forbidden.
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-methods'] = corsAllowedMethods;
    headers['access-control-allow-headers'] = corsAllowedHeaders;
  }

  return headers;
}

function jsonResponse(
  request: AuthRequest,
  allowedOrigins: readonly string[],
  status: number,
  body: unknown,
): ExamResponse {
  return {
    status,
    headers: {
      ...corsHeaders(request, allowedOrigins),
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
    body,
  };
}

function problemResponse(
  request: AuthRequest,
  allowedOrigins: readonly string[],
  error: unknown,
): ExamResponse {
  const problem = problemFromError(error);
  return {
    status: problemStatus[problem.code],
    headers: {
      ...corsHeaders(request, allowedOrigins),
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
    },
    body: problem,
  };
}

function isExamPath(path: string): boolean {
  return (
    path === '/exam/assignments' ||
    path === '/exam/phone-heartbeat' ||
    path === '/exam/speedtest' ||
    path === instructorVersionsPath ||
    similarityPattern.test(path) ||
    instructorAiCheckPattern.test(path) ||
    [
      '/exam/phone-presence/claim',
      '/exam/phone-presence/challenge',
      '/exam/phone-presence/heartbeat',
    ].includes(path) ||
    phonePresencePattern.test(path) ||
    path === '/exam/generate' ||
    assignmentStartPattern.test(path) ||
    attemptPattern.test(path) ||
    answersPattern.test(path) ||
    submitPattern.test(path) ||
    audioPattern.test(path) ||
    livChallengePattern.test(path) ||
    livVerifyPattern.test(path) ||
    eventsPattern.test(path) ||
    enrollPhonePattern.test(path) ||
    phoneStatusPattern.test(path) ||
    revisionsPattern.test(path) ||
    recordingPattern.test(path) ||
    visionPattern.test(path) ||
    telemetryPattern.test(path) ||
    transpPattern.test(path)
  );
}

function parsePathId<Brand extends string>(value: string, field: string): Opaque<string, Brand> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DomainError('validation_failed', `${field} is invalid.`);
  }

  if (decoded.trim() === '' || decoded.includes('/')) {
    throw new DomainError('validation_failed', `${field} is invalid.`);
  }
  return decoded as Opaque<string, Brand>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('validation_failed', message);
  }
  return value as Record<string, unknown>;
}

function parseAnswerSaveRequest(body: unknown): ExamAnswerSaveRequest {
  const candidate = parseObject(body, 'An answer snapshot is required.');
  if (
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    typeof candidate.idempotencyKey !== 'string' ||
    typeof candidate.answers !== 'object' ||
    candidate.answers === null ||
    Array.isArray(candidate.answers)
  ) {
    throw new DomainError('validation_failed', 'The answer snapshot is invalid.');
  }
  return {
    revision: candidate.revision,
    idempotencyKey: candidate.idempotencyKey,
    answers: candidate.answers as Record<string, never>,
  };
}

function parseSubmitRequest(body: unknown): ExamSubmitRequest {
  const candidate = parseObject(body, 'A submission request is required.');
  if (
    typeof candidate.expectedRevision !== 'number' ||
    !Number.isSafeInteger(candidate.expectedRevision) ||
    candidate.expectedRevision < 0 ||
    typeof candidate.idempotencyKey !== 'string'
  ) {
    throw new DomainError('validation_failed', 'The submission request is invalid.');
  }
  return {
    expectedRevision: candidate.expectedRevision,
    idempotencyKey: candidate.idempotencyKey,
  };
}

function requestedHeadersAreAllowed(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return true;
  }
  return value
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== '')
    .every((header) => corsRequestHeaders.has(header));
}

export class ExamRoutes {
  private readonly generationInFlight = new Set<string>();

  constructor(
    private readonly service: ExamService,
    private readonly boundary: AuthRequestBoundary,
    private readonly config: ApiConfig,
    private readonly integrity: IntegrityService | null = null,
    private readonly phonePresence: PhonePresenceService | null = null,
    // Opt-in (ENABLE_BACKEND_VISION): server-side OWL-ViT detection via the Python bridge.
    private readonly visionDetector: ((imageBase64: string) => Promise<VisionResult>) | null = null,
  ) {}

  async handle(request: AuthRequest): Promise<ExamResponse> {
    try {
      const method = request.method.toUpperCase();
      const path = request.path.split('?')[0] ?? request.path;

      if (method === 'OPTIONS') {
        return this.preflightResponse(request, path);
      }
      this.assertAllowedOrigin(request);

      const presenceMatch = phonePresencePattern.exec(path);
      if (presenceMatch && this.phonePresence && (method === 'GET' || method === 'POST')) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(presenceMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        return jsonResponse(
          request,
          this.config.allowedOrigins,
          method === 'POST' ? 201 : 200,
          method === 'POST'
            ? this.phonePresence.enroll(attemptId)
            : this.phonePresence.status(attemptId),
        );
      }
      if (method === 'POST' && this.phonePresence && path.startsWith('/exam/phone-presence/')) {
        const body = parseObject(request.body, 'Phone presence body required');
        // Native endpoints authenticate only the scoped credential, never browser cookies.
        if (path === '/exam/phone-presence/claim') {
          return jsonResponse(
            request,
            this.config.allowedOrigins,
            200,
            this.phonePresence.claim(body.code),
          );
        }
        if (path === '/exam/phone-presence/challenge') {
          return jsonResponse(
            request,
            this.config.allowedOrigins,
            200,
            this.phonePresence.challenge(body.credential),
          );
        }
        if (path === '/exam/phone-presence/heartbeat') {
          return jsonResponse(
            request,
            this.config.allowedOrigins,
            200,
            this.phonePresence.heartbeat(
              body.credential,
              body.challenge,
              body.sequence,
              body.active,
            ),
          );
        }
      }

      if (method === 'POST' && path === '/exam/generate') {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        if (!this.config.freshExamGenerationEnabled) {
          throw new DomainError('forbidden', 'Fresh exam generation is disabled.');
        }
        const studentId = String(principal.user.id);
        if (this.generationInFlight.has(studentId)) {
          throw new DomainError('conflict', 'An exam is already being generated.');
        }

        this.generationInFlight.add(studentId);
        try {
          const result = await this.service.generateFreshExamForStudent(principal.user.id, {
            geminiKeys: this.config.geminiKeys,
            geminiModel: this.config.geminiModel,
            geminiEmbeddingModel: this.config.geminiEmbeddingModel,
          });
          return jsonResponse(request, this.config.allowedOrigins, 201, result);
        } finally {
          this.generationInFlight.delete(studentId);
        }
      }

      if (method === 'GET' && path === '/exam/assignments') {
        const principal = this.requireStudent(request);
        return jsonResponse(
          request,
          this.config.allowedOrigins,
          200,
          await this.service.listAssignments(principal.user.id),
        );
      }

      const startMatch = assignmentStartPattern.exec(path);
      if (method === 'POST' && startMatch !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const result = await this.service.startAttempt(
          parsePathId<'AssignmentId'>(startMatch[1] ?? '', 'Assignment ID') as AssignmentId,
          principal.user.id,
        );
        return jsonResponse(request, this.config.allowedOrigins, result.created ? 201 : 200, {
          delivery: result.delivery,
        });
      }

      const answersMatch = answersPattern.exec(path);
      if (method === 'PUT' && answersMatch !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(
          answersMatch[1] ?? '',
          'Attempt ID',
        ) as AttemptId;
        const saveReq = parseAnswerSaveRequest(request.body);
        const result = await this.service.saveAnswers(attemptId, principal.user.id, saveReq);
        // Pack 8: record a revision for each written answer
        if (this.integrity !== null) {
          for (const [qId, val] of Object.entries(saveReq.answers)) {
            if (typeof val === 'string' && val.length > 0) {
              this.integrity.recordAnswerRevision(String(attemptId), qId, val);
            }
          }
        }
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      const submitMatch = submitPattern.exec(path);
      if (method === 'POST' && submitMatch !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        if (request.body === undefined || request.body === null) {
          const delivery = await this.service.submitAttempt(
            parsePathId<'AttemptId'>(submitMatch[1] ?? '', 'Attempt ID') as AttemptId,
            principal.user.id,
          );
          return jsonResponse(request, this.config.allowedOrigins, 200, { delivery });
        }
        const result = await this.service.submitAttemptWithAnswers(
          parsePathId<'AttemptId'>(submitMatch[1] ?? '', 'Attempt ID') as AttemptId,
          principal.user.id,
          parseSubmitRequest(request.body),
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      const attemptMatch = attemptPattern.exec(path);
      if (method === 'GET' && attemptMatch !== null) {
        const principal = this.requireStudent(request);
        const delivery = await this.service.getAttemptDelivery(
          parsePathId<'AttemptId'>(attemptMatch[1] ?? '', 'Attempt ID') as AttemptId,
          principal.user.id,
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, { delivery });
      }

      // ── Pack 8: Liveness Challenge ─────────────────────────────────────────
      const livChalMatch = livChallengePattern.exec(path);
      if (method === 'POST' && livChalMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const delivery = await this.service.getAttemptDelivery(
          parsePathId<'AttemptId'>(livChalMatch[1] ?? '', 'Attempt ID') as AttemptId,
          principal.user.id,
        );
        const challenge = this.integrity.issueLivenessChallenge(
          delivery.attempt.id,
          delivery.attempt.startedAt,
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, challenge);
      }

      // ── Pack 8: Liveness Verify ────────────────────────────────────────────
      const livVerifyMatch = livVerifyPattern.exec(path);
      if (method === 'POST' && livVerifyMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(livVerifyMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const body = parseObject(request.body, 'Liveness verify body required');
        const result = await this.integrity.verifyLiveness(
          String(attemptId),
          String(body.nonce ?? ''),
          Number(body.layer ?? 2),
          isRecord(body.payload) ? body.payload : {},
          body.imageBase64 ? String(body.imageBase64) : undefined,
          body.signature,
          isRecord(body.camera) && typeof body.camera.label === 'string'
            ? body.camera.label
            : undefined,
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      // ── Pack 8: Native companion events ───────────────────────────────────
      const eventsMatch = eventsPattern.exec(path);
      if (method === 'PATCH' && eventsMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(eventsMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const body = parseObject(request.body, 'Events body required');
        this.integrity.recordAppEvent(
          String(attemptId),
          String(
            body.foregroundApp ??
              (body.event === undefined ? 'unknown' : `flag:${String(body.event)}`),
          ).slice(0, 200),
          Number(body.displayCount ?? 1),
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, { ok: true });
      }

      // ── Telemetry batch (keystroke dynamics, gaze, voice activity) ───────
      const telemetryMatch = telemetryPattern.exec(path);
      if (method === 'POST' && telemetryMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(telemetryMatch[1] ?? '', 'Attempt ID');
        const delivery = await this.service.getAttemptDelivery(
          attemptId as AttemptId,
          principal.user.id,
        );
        if (delivery.attempt.status !== 'in_progress') {
          throw new DomainError(
            'conflict',
            'Telemetry is only accepted while the attempt is in progress.',
          );
        }
        const body = parseObject(request.body, 'Telemetry body required');
        const accepted = this.integrity.recordTelemetry(String(attemptId), body);
        return jsonResponse(request, this.config.allowedOrigins, 202, { accepted });
      }

      // ── Transparency report: what was recorded about this attempt ────────
      const transparencyMatch = transpPattern.exec(path);
      if (method === 'GET' && transparencyMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        const attemptId = parsePathId<'AttemptId'>(transparencyMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const events = await this.integrity.getTransparencyReport(String(attemptId));
        return jsonResponse(request, this.config.allowedOrigins, 200, { events });
      }

      // ── Instructor: cross-student similarity review ───────────────────────
      if (method === 'GET' && path === instructorVersionsPath && this.integrity !== null) {
        this.requireInstructor(request);
        const versions = this.integrity.listInstructorVersions();
        return jsonResponse(request, this.config.allowedOrigins, 200, { versions });
      }
      const similarityMatch = similarityPattern.exec(path);
      if (method === 'POST' && similarityMatch !== null && this.integrity !== null) {
        const principal = this.requireInstructor(request);
        this.boundary.validateUnsafe(request, principal);
        const result = await this.integrity.runSimilarity(
          parsePathId<'ExamVersionId'>(similarityMatch[1] ?? '', 'Exam version ID'),
          parsePathId<'QuestionVersionId'>(similarityMatch[2] ?? '', 'Question ID'),
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      // ── Backend vision: second-opinion object detection on a camera frame ─
      const visionMatch = visionPattern.exec(path);
      if (method === 'POST' && visionMatch !== null && this.visionDetector !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(visionMatch[1] ?? '', 'Attempt ID');
        const delivery = await this.service.getAttemptDelivery(
          attemptId as AttemptId,
          principal.user.id,
        );
        if (delivery.attempt.status !== 'in_progress') {
          throw new DomainError(
            'conflict',
            'Vision checks are only accepted while the attempt is in progress.',
          );
        }
        const body = parseObject(request.body, 'Vision body required');
        const image =
          typeof body.imageBase64 === 'string'
            ? body.imageBase64.replace(/^data:image\/\w+;base64,/u, '')
            : '';
        if (image === '' || image.length > 2_000_000 || !/^[A-Za-z0-9+/=]+$/u.test(image)) {
          throw new DomainError(
            'validation_failed',
            'A base64 camera frame under 1.5 MB is required.',
          );
        }
        const result = await this.visionDetector(image);
        const threats = (result.detections ?? []).filter(
          (detection) => detection.label !== 'person',
        );
        for (const threat of threats) {
          this.integrity?.recordAppEvent(
            String(attemptId),
            `flag:vision_${threat.label.replaceAll(' ', '_')}`,
            1,
          );
        }
        return jsonResponse(request, this.config.allowedOrigins, 200, {
          status: result.status,
          detections: threats.map((threat) => ({ label: threat.label, score: threat.score })),
        });
      }

      const instructorAiCheckMatch = instructorAiCheckPattern.exec(path);
      if (method === 'POST' && instructorAiCheckMatch !== null && this.integrity !== null) {
        const principal = this.requireInstructor(request);
        this.boundary.validateUnsafe(request, principal);
        const result = await this.integrity.runAiCheckForQuestion(
          parsePathId<'ExamVersionId'>(instructorAiCheckMatch[1] ?? '', 'Exam version ID'),
          parsePathId<'QuestionVersionId'>(instructorAiCheckMatch[2] ?? '', 'Question ID'),
        );
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      // ── Pack 8: Phone enrollment ──────────────────────────────────────────
      const enrollMatch = enrollPhonePattern.exec(path);
      if (method === 'POST' && enrollMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(enrollMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const response = this.integrity.enrollPhone(String(attemptId));
        return jsonResponse(request, this.config.allowedOrigins, 201, response);
      }

      // ── Pack 8: Phone status ──────────────────────────────────────────────
      const phoneStatusMatch = phoneStatusPattern.exec(path);
      if (method === 'GET' && phoneStatusMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        const attemptId = parsePathId<'AttemptId'>(phoneStatusMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const result = this.integrity.checkPhoneStatus(String(attemptId));
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      // ── Pack 8: Phone heartbeat ───────────────────────────────────────────
      if (method === 'POST' && path === '/exam/phone-heartbeat' && this.integrity !== null) {
        const body = parseObject(request.body, 'Heartbeat body required');
        const result = this.integrity.phoneHeartbeat(String(body.token ?? ''));
        return jsonResponse(request, this.config.allowedOrigins, 200, result);
      }

      // ── Pack 8: Answer revisions ──────────────────────────────────────────
      const revisionsMatch = revisionsPattern.exec(path);
      if (method === 'GET' && revisionsMatch !== null && this.integrity !== null) {
        const principal = this.requireStudent(request);
        const attemptId = parsePathId<'AttemptId'>(revisionsMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);
        const qId = new URL(`http://x${request.path}`).searchParams.get('questionId') ?? '';
        const revisions = this.integrity.getRevisions(String(attemptId), qId);
        return jsonResponse(request, this.config.allowedOrigins, 200, { revisions });
      }

      // ── Pack 8: Audio Transcription (Whisper) ─────────────────────────────
      const audioMatch = audioPattern.exec(path);
      if (method === 'POST' && audioMatch !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(audioMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);

        // The client sends a complete recording container as base64 JSON.
        const body = parseObject(request.body, 'Audio chunk required');
        const audioBase64 = String(body.audio ?? '');
        const buffer = Buffer.from(audioBase64, 'base64');

        try {
          const { transcribeAudio } = await import('../integrity/whisper.js');
          const transcript = await transcribeAudio(buffer);

          if (transcript && transcript.length > 0) {
            // Log it to the database
            if (this.integrity) {
              this.integrity.recordAppEvent(
                String(attemptId),
                `🎙️ Whisper Transcript: "${transcript}"`,
                1,
              );
            }
          }

          return jsonResponse(request, this.config.allowedOrigins, 201, { transcript });
        } catch (error) {
          console.error('Local transcription failed or is busy.');
          const { TranscriptionError } = await import('../integrity/whisper.js');
          return jsonResponse(request, this.config.allowedOrigins, 503, {
            code: 'invalid_state',
            message:
              error instanceof TranscriptionError
                ? error.message
                : 'Local transcription is unavailable. Retry audio after checking the server.',
          });
        }
      }

      // ── Pack 8: Speedtest ─────────────────────────────────────────────────
      if (method === 'POST' && speedtestPattern.test(path)) {
        // Upload-speed probe for adaptive recording: signed-in students only,
        // and the body is discarded once it has been received.
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        return jsonResponse(request, this.config.allowedOrigins, 200, { ok: true });
      }

      // ── Pack 8: Cloud Recording ───────────────────────────────────────────
      const recordingMatch = recordingPattern.exec(path);
      if (method === 'POST' && recordingMatch !== null) {
        const principal = this.requireStudent(request);
        this.boundary.validateUnsafe(request, principal);
        const attemptId = parsePathId<'AttemptId'>(recordingMatch[1] ?? '', 'Attempt ID');
        await this.service.getAttemptDelivery(attemptId as AttemptId, principal.user.id);

        const body = parseObject(request.body, 'Recording chunk required');
        const chunkIndex = body.index;
        if (
          typeof chunkIndex !== 'number' ||
          !Number.isInteger(chunkIndex) ||
          chunkIndex < 0 ||
          chunkIndex > MAX_RECORDING_INDEX
        ) {
          throw new DomainError('validation_failed', 'Recording segment index is invalid.');
        }
        const chunkBase64 = body.chunk;
        if (
          typeof chunkBase64 !== 'string' ||
          chunkBase64.length === 0 ||
          chunkBase64.length > MAX_RECORDING_BASE64_CHARS ||
          !base64Pattern.test(chunkBase64)
        ) {
          throw new DomainError('validation_failed', 'Recording segment is empty or too large.');
        }
        if (!isRecordingUploadConfigured(this.config)) {
          return jsonResponse(request, this.config.allowedOrigins, 503, {
            code: 'invalid_state',
            message: 'Cloud recording is not configured. Save recording segments locally instead.',
          });
        }

        // Folder layout: <studentId>/<attemptId>/segment-<index>.webm
        await uploadRecordingChunk(
          this.config,
          principal.user.id,
          String(attemptId),
          chunkIndex,
          Buffer.from(chunkBase64, 'base64'),
        );

        return jsonResponse(request, this.config.allowedOrigins, 202, { ok: true });
      }

      throw new DomainError('not_found', 'The requested exam route does not exist.');
    } catch (error) {
      return problemResponse(request, this.config.allowedOrigins, error);
    }
  }

  private requireInstructor(request: AuthRequest) {
    const principal = this.boundary.requirePrincipal(request);
    this.boundary.requireRole(principal, 'instructor');
    return principal;
  }

  private requireStudent(request: AuthRequest) {
    const principal = this.boundary.requirePrincipal(request);
    this.boundary.requireRole(principal, 'student');
    return principal;
  }

  private assertAllowedOrigin(request: AuthRequest): void {
    const origin = headerValue(request.headers, 'origin');
    if (origin !== undefined && !isAllowedOrigin(origin, this.config.allowedOrigins)) {
      throw new DomainError('forbidden', 'The request origin is not allowed.');
    }
  }

  private preflightResponse(request: AuthRequest, path: string): ExamResponse {
    if (!isExamPath(path)) {
      throw new DomainError('not_found', 'The requested exam route does not exist.');
    }
    this.assertAllowedOrigin(request);
    const method = headerValue(request.headers, 'access-control-request-method')?.toUpperCase();
    if (method === undefined || !corsRequestMethods.has(method)) {
      throw new DomainError('forbidden', 'The requested CORS method is not allowed.');
    }
    if (
      !requestedHeadersAreAllowed(headerValue(request.headers, 'access-control-request-headers'))
    ) {
      throw new DomainError('forbidden', 'The requested CORS headers are not allowed.');
    }

    return {
      status: 204,
      headers: corsHeaders(request, this.config.allowedOrigins),
      body: null,
    };
  }
}
