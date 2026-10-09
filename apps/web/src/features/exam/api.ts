import type {
  ExamAnswerSaveRequest,
  ExamAnswerSaveResponse,
  ExamAnswerValue,
  ExamAssignmentListResponse,
  ExamDeliveryProjection,
  ExamGenerationResponse,
  ExamSubmitRequest,
  ExamSubmitResponse,
  LivenessChallengeType,
  TransparencyEvent,
} from '@exam-anti-cheat/contracts/exam';

import type { FetchLike } from '../auth/api.js';

export interface ExamProblem {
  readonly code:
    'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'validation_failed' | 'invalid_state';
  readonly message: string;
}

export class ExamApiError extends Error {
  constructor(
    readonly problem: ExamProblem,
    readonly status?: number,
  ) {
    super(problem.message);
    this.name = 'ExamApiError';
  }
}

export type CsrfTokenProvider = () => Promise<string>;

export interface LivenessChallenge {
  readonly nonce: string;
  readonly type: LivenessChallengeType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface LivenessVerifyResult {
  readonly passed: boolean;
  readonly layer: number;
  readonly detail: string;
}

export interface PhoneEnrollment {
  readonly token: string;
  readonly qrData: string;
  readonly expiresAt: string;
}

const safeProblems: Readonly<Record<number, ExamProblem>> = {
  400: { code: 'validation_failed', message: 'The exam request was invalid.' },
  401: { code: 'unauthorized', message: 'Authentication is required.' },
  403: { code: 'forbidden', message: 'You do not have permission to view this exam.' },
  404: { code: 'not_found', message: 'The exam could not be found.' },
  409: { code: 'conflict', message: 'The exam is not available in its current state.' },
};

const fallbackProblem: ExamProblem = {
  code: 'invalid_state',
  message: 'The exam request could not be completed.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isQuestionType(value: unknown): boolean {
  return (
    value === 'multiple_choice' ||
    value === 'true_false' ||
    value === 'identification' ||
    value === 'numeric' ||
    value === 'short_answer'
  );
}

function isAttemptStatus(value: unknown): boolean {
  return value === 'in_progress' || value === 'submitted' || value === 'expired';
}

function isOption(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isString(value.text);
}

function isAnswerValue(value: unknown): boolean {
  return value === null || isString(value) || typeof value === 'boolean' || isFiniteNumber(value);
}

function isAnswerSnapshot(value: unknown): value is ExamDeliveryProjection['answers'] {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.revision === 'number' &&
    value.revision >= 0 &&
    (value.savedAt === null || isString(value.savedAt)) &&
    isRecord(value.answers) &&
    Object.values(value.answers).every(isAnswerValue)
  );
}

function isDelivery(value: unknown): value is ExamDeliveryProjection {
  if (
    !isRecord(value) ||
    !isRecord(value.exam) ||
    !isRecord(value.assignment) ||
    !isRecord(value.answers)
  ) {
    return false;
  }
  if (!isRecord(value.attempt) || !Array.isArray(value.questions)) {
    return false;
  }

  const exam = value.exam;
  const assignment = value.assignment;
  const attempt = value.attempt;
  const answerSnapshot = value.answers;
  return (
    isString(exam.id) &&
    isString(exam.versionId) &&
    isString(exam.title) &&
    Number.isSafeInteger(exam.versionNumber) &&
    isFiniteNumber(exam.durationSeconds) &&
    isString(assignment.id) &&
    isString(assignment.examVersionId) &&
    isString(assignment.title) &&
    Number.isSafeInteger(assignment.versionNumber) &&
    isString(assignment.assignedAt) &&
    Number.isSafeInteger(assignment.extraTimeSeconds) &&
    isString(assignment.attemptId) &&
    isAttemptStatus(assignment.attemptStatus) &&
    isString(attempt.id) &&
    isString(attempt.assignmentId) &&
    isAttemptStatus(attempt.status) &&
    isString(attempt.startedAt) &&
    isString(attempt.effectiveDeadline) &&
    (attempt.submittedAt === null || isString(attempt.submittedAt)) &&
    (attempt.expiredAt === null || isString(attempt.expiredAt)) &&
    isAnswerSnapshot(answerSnapshot) &&
    value.questions.every(
      (question) =>
        isRecord(question) &&
        isString(question.id) &&
        isQuestionType(question.type) &&
        isString(question.prompt) &&
        Array.isArray(question.options) &&
        question.options.every(isOption),
    )
  );
}

function sanitizeDelivery(value: ExamDeliveryProjection): ExamDeliveryProjection {
  return {
    exam: {
      id: value.exam.id,
      versionId: value.exam.versionId,
      title: value.exam.title,
      versionNumber: value.exam.versionNumber,
      durationSeconds: value.exam.durationSeconds,
    },
    assignment: {
      id: value.assignment.id,
      examVersionId: value.assignment.examVersionId,
      title: value.assignment.title,
      versionNumber: value.assignment.versionNumber,
      assignedAt: value.assignment.assignedAt,
      extraTimeSeconds: value.assignment.extraTimeSeconds,
      attemptId: value.assignment.attemptId,
      attemptStatus: value.assignment.attemptStatus,
    },
    attempt: {
      id: value.attempt.id,
      assignmentId: value.attempt.assignmentId,
      status: value.attempt.status,
      startedAt: value.attempt.startedAt,
      effectiveDeadline: value.attempt.effectiveDeadline,
      submittedAt: value.attempt.submittedAt,
      expiredAt: value.attempt.expiredAt,
    },
    answers: {
      revision: value.answers.revision,
      savedAt: value.answers.savedAt,
      answers: { ...value.answers.answers },
    },
    questions: value.questions.map((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
    })),
  };
}

function sanitizeAssignmentList(value: ExamAssignmentListResponse): ExamAssignmentListResponse {
  return {
    assignments: value.assignments.map((assignment) => ({
      id: assignment.id,
      examVersionId: assignment.examVersionId,
      title: assignment.title,
      versionNumber: assignment.versionNumber,
      assignedAt: assignment.assignedAt,
      extraTimeSeconds: assignment.extraTimeSeconds,
      attemptId: assignment.attemptId,
      attemptStatus: assignment.attemptStatus,
    })),
  };
}

function isAssignmentList(value: unknown): value is ExamAssignmentListResponse {
  if (!isRecord(value) || !Array.isArray(value.assignments)) {
    return false;
  }

  return value.assignments.every(
    (assignment) =>
      isRecord(assignment) &&
      isString(assignment.id) &&
      isString(assignment.examVersionId) &&
      isString(assignment.title) &&
      Number.isSafeInteger(assignment.versionNumber) &&
      isString(assignment.assignedAt) &&
      Number.isSafeInteger(assignment.extraTimeSeconds) &&
      (assignment.attemptId === null || isString(assignment.attemptId)) &&
      (assignment.attemptStatus === null || isAttemptStatus(assignment.attemptStatus)),
  );
}

export interface PhonePresenceStatus {
  required: boolean;
  active: boolean;
  remainingMs: number;
  deskCamera?: { on: boolean; framingOk: boolean; people: number; handsVisible: boolean };
}

export interface ExamApi {
  getPhonePresence(attemptId: string, signal?: AbortSignal): Promise<PhonePresenceStatus>;
  requirePhonePresence(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<{ code: string; expiresAt: string }>;
  listAssignments(): Promise<ExamAssignmentListResponse>;
  generateExam(): Promise<ExamGenerationResponse>;
  getPhoneStatus(attemptId: string): Promise<{ active: boolean }>;
  uploadTelemetry(attemptId: string, payload: unknown): Promise<void>;
  startAttempt(assignmentId: string): Promise<ExamDeliveryProjection>;
  getAttempt(attemptId: string): Promise<ExamDeliveryProjection>;
  saveAnswers(attemptId: string, request: ExamAnswerSaveRequest): Promise<ExamAnswerSaveResponse>;
  submitAttempt(attemptId: string, request: ExamSubmitRequest): Promise<ExamSubmitResponse>;
  postLivenessChallenge(
    attemptId: string,
    preferred?: Exclude<LivenessChallengeType, 'colour_flash'>,
  ): Promise<LivenessChallenge>;
  postLivenessVerify(
    attemptId: string,
    body: Record<string, unknown>,
  ): Promise<LivenessVerifyResult>;
  postAudio(
    attemptId: string,
    audioBase64: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly transcript?: unknown }>;
  postEnrollPhone(attemptId: string): Promise<PhoneEnrollment>;
  patchEvents(attemptId: string, body: Record<string, unknown>): Promise<unknown>;
  speedtest(dummyData: string): Promise<void>;
  uploadRecordingChunk(attemptId: string, index: number, chunkBase64: string): Promise<void>;
  getTransparencyReport?(attemptId: string): Promise<readonly TransparencyEvent[]>;
  /** Whether the opt-in server vision (OWL-ViT) second opinion is enabled. */
  getServerVisionEnabled?(signal?: AbortSignal): Promise<boolean>;
  postVisionCheck?(
    attemptId: string,
    imageBase64: string,
    signal?: AbortSignal,
  ): Promise<readonly { readonly label: string; readonly score: number }[]>;
}

export class BrowserExamApi implements ExamApi {
  private readonly baseUrl: string;

  constructor(
    baseUrl = '',
    private readonly csrfTokenProvider: CsrfTokenProvider,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
  }

  async listAssignments(): Promise<ExamAssignmentListResponse> {
    const body = await this.request('/exam/assignments', 'GET');
    if (!isAssignmentList(body)) {
      throw new ExamApiError(fallbackProblem);
    }
    return sanitizeAssignmentList(body);
  }

  async generateExam(): Promise<ExamGenerationResponse> {
    const body = await this.request('/exam/generate', 'POST', undefined, true);
    if (
      !isRecord(body) ||
      !isString(body.assignmentId) ||
      (body.source !== 'gemini' && body.source !== 'fallback')
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return {
      assignmentId: body.assignmentId as ExamGenerationResponse['assignmentId'],
      source: body.source,
    };
  }

  async startAttempt(assignmentId: string): Promise<ExamDeliveryProjection> {
    return this.delivery(
      await this.request(
        `/exam/assignments/${encodeURIComponent(assignmentId)}/start`,
        'POST',
        undefined,
        true,
      ),
    );
  }

  async getAttempt(attemptId: string): Promise<ExamDeliveryProjection> {
    return this.delivery(
      await this.request(`/exam/attempts/${encodeURIComponent(attemptId)}`, 'GET'),
    );
  }

  async saveAnswers(
    attemptId: string,
    request: ExamAnswerSaveRequest,
  ): Promise<ExamAnswerSaveResponse> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/answers`,
      'PUT',
      request,
      true,
    );
    if (
      !isRecord(body) ||
      !isString(body.attemptId) ||
      typeof body.revision !== 'number' ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1 ||
      !isString(body.savedAt) ||
      !isRecord(body.answers) ||
      !Object.values(body.answers).every(isAnswerValue)
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return {
      attemptId: body.attemptId as ExamAnswerSaveResponse['attemptId'],
      revision: body.revision,
      savedAt: body.savedAt,
      answers: { ...body.answers } as Record<string, ExamAnswerValue>,
    };
  }

  async submitAttempt(attemptId: string, request: ExamSubmitRequest): Promise<ExamSubmitResponse> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/submit`,
      'POST',
      request,
      true,
    );
    if (
      !isRecord(body) ||
      !isDelivery(body.delivery) ||
      !isRecord(body.receipt) ||
      !isString(body.receipt.attemptId) ||
      !isAttemptStatus(body.receipt.status) ||
      typeof body.receipt.revision !== 'number' ||
      !Number.isSafeInteger(body.receipt.revision) ||
      body.receipt.revision < 0 ||
      (body.receipt.submittedAt !== null && !isString(body.receipt.submittedAt)) ||
      (body.receipt.expiredAt !== null && !isString(body.receipt.expiredAt))
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return {
      delivery: sanitizeDelivery(body.delivery),
      receipt: {
        attemptId: body.receipt.attemptId as ExamSubmitResponse['receipt']['attemptId'],
        status: body.receipt.status as ExamSubmitResponse['receipt']['status'],
        revision: body.receipt.revision,
        submittedAt: body.receipt.submittedAt,
        expiredAt: body.receipt.expiredAt,
      },
    };
  }

  async postLivenessChallenge(
    attemptId: string,
    preferred?: Exclude<LivenessChallengeType, 'colour_flash'>,
  ): Promise<LivenessChallenge> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/liveness-challenge`,
      'POST',
      preferred === undefined ? undefined : { preferred },
      true,
    );
    if (
      !isRecord(body) ||
      !isString(body.nonce) ||
      (body.type !== 'colour_flash' && body.type !== 'head_turn' && body.type !== 'spoken_words') ||
      !isRecord(body.data) ||
      !isString(body.expiresAt) ||
      !isString(body.signature)
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return {
      nonce: body.nonce,
      type: body.type,
      data: body.data,
      expiresAt: body.expiresAt,
      signature: body.signature,
    };
  }

  async postLivenessVerify(
    attemptId: string,
    request: Record<string, unknown>,
  ): Promise<LivenessVerifyResult> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/liveness-verify`,
      'POST',
      request,
      true,
    );
    if (
      !isRecord(body) ||
      typeof body.passed !== 'boolean' ||
      typeof body.layer !== 'number' ||
      !isString(body.detail)
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return { passed: body.passed, layer: body.layer, detail: body.detail };
  }

  async postAudio(
    attemptId: string,
    audioBase64: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly transcript?: unknown }> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(cancel, 50000); // 15s conversion + 30s inference + transport.
    try {
      const token = await this.csrfTokenProvider();
      const response = await this.fetchImpl(
        `${this.baseUrl}/exam/attempts/${encodeURIComponent(attemptId)}/audio`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify({ audio: audioBase64, durationMs }),
          credentials: 'include',
        },
      );
      if (!response.ok) {
        if (response.status === 503) {
          const body: unknown = await response.json().catch(() => null);
          if (
            isRecord(body) &&
            body.code === 'invalid_state' &&
            typeof body.message === 'string' &&
            body.message.length < 300
          )
            throw new Error(body.message);
        }
        throw new ExamApiError(safeProblems[response.status] ?? fallbackProblem);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('Transcription stopped or timed out. Check the server, then retry audio.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async getPhoneStatus(attemptId: string): Promise<{ active: boolean }> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/phone-status`,
      'GET',
      undefined,
      true,
    );
    if (!isRecord(body) || typeof body.active !== 'boolean') {
      throw new ExamApiError(fallbackProblem);
    }
    return { active: body.active };
  }

  async getPhonePresence(attemptId: string, signal?: AbortSignal): Promise<PhonePresenceStatus> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/phone-presence`,
      'GET',
      undefined,
      false,
      signal,
    );
    if (
      !isRecord(body) ||
      typeof body.required !== 'boolean' ||
      typeof body.active !== 'boolean' ||
      typeof body.remainingMs !== 'number' ||
      !Number.isFinite(body.remainingMs) ||
      body.remainingMs < 0 ||
      body.remainingMs > 8000
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    const desk = isRecord(body.deskCamera) ? body.deskCamera : null;
    return {
      required: body.required,
      active: body.active,
      remainingMs: body.remainingMs,
      ...(desk && typeof desk.on === 'boolean' && typeof desk.framingOk === 'boolean'
        ? {
            deskCamera: {
              on: desk.on,
              framingOk: desk.framingOk,
              people: typeof desk.people === 'number' ? desk.people : 0,
              handsVisible: desk.handsVisible === true,
            },
          }
        : {}),
    };
  }

  async requirePhonePresence(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<{ code: string; expiresAt: string }> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/phone-presence`,
      'POST',
      undefined,
      true,
      signal,
    );
    if (
      !isRecord(body) ||
      typeof body.code !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.code) ||
      typeof body.expiresAt !== 'string'
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return { code: body.code, expiresAt: body.expiresAt };
  }

  async postEnrollPhone(attemptId: string): Promise<PhoneEnrollment> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/enroll-phone`,
      'POST',
      undefined,
      true,
    );
    if (
      !isRecord(body) ||
      !isString(body.token) ||
      !isString(body.qrData) ||
      !isString(body.expiresAt)
    ) {
      throw new ExamApiError(fallbackProblem);
    }
    return { token: body.token, qrData: body.qrData, expiresAt: body.expiresAt };
  }

  async patchEvents(attemptId: string, body: Record<string, unknown>): Promise<unknown> {
    // Note: patch is not naturally supported by request method, so we make a direct call
    const token = await this.csrfTokenProvider();
    const response = await this.fetchImpl(
      `${this.baseUrl}/exam/attempts/${encodeURIComponent(attemptId)}/events`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
        credentials: 'include',
      },
    );
    if (!response.ok) throw new ExamApiError(safeProblems[response.status] ?? fallbackProblem);
    return response.json();
  }

  async speedtest(dummyData: string): Promise<void> {
    await this.request('/exam/speedtest', 'POST', { data: dummyData }, true);
  }

  async uploadTelemetry(attemptId: string, payload: unknown): Promise<void> {
    await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/telemetry`,
      'POST',
      payload,
      true,
    );
  }

  async uploadRecordingChunk(attemptId: string, index: number, chunkBase64: string): Promise<void> {
    await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/recording`,
      'POST',
      { index, chunk: chunkBase64 },
      true,
    );
  }

  async getServerVisionEnabled(signal?: AbortSignal): Promise<boolean> {
    const body = await this.request('/exam/vision-status', 'GET', undefined, false, signal);
    return isRecord(body) && body.enabled === true;
  }

  async postVisionCheck(
    attemptId: string,
    imageBase64: string,
    signal?: AbortSignal,
  ): Promise<readonly { readonly label: string; readonly score: number }[]> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/vision-check`,
      'POST',
      { imageBase64 },
      true,
      signal,
    );
    if (!isRecord(body) || body.status !== 'ok' || !Array.isArray(body.detections)) {
      throw new ExamApiError(fallbackProblem);
    }
    return body.detections.filter(
      (item): item is { label: string; score: number } =>
        isRecord(item) && isString(item.label) && typeof item.score === 'number',
    );
  }

  async getTransparencyReport(attemptId: string): Promise<readonly TransparencyEvent[]> {
    const body = await this.request(
      `/exam/attempts/${encodeURIComponent(attemptId)}/transparency`,
      'GET',
    );
    if (!isRecord(body) || !Array.isArray(body.events)) throw new ExamApiError(fallbackProblem);
    const types = new Set(['HARDWARE', 'SOFTWARE', 'VISION', 'GAZE', 'AUDIO']);
    const severities = new Set(['low', 'medium', 'high']);
    return body.events.filter(
      (event): event is TransparencyEvent =>
        isRecord(event) &&
        isString(event.timestamp) &&
        isString(event.description) &&
        types.has(event.type as string) &&
        severities.has(event.severity as string),
    );
  }

  private delivery(body: unknown): ExamDeliveryProjection {
    if (!isRecord(body) || !isDelivery(body.delivery)) {
      throw new ExamApiError(fallbackProblem);
    }
    return sanitizeDelivery(body.delivery);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
    unsafe = false,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (unsafe) {
      headers['x-csrf-token'] = await this.csrfTokenProvider();
    }

    const init: RequestInit = {
      credentials: 'include',
      headers,
      method,
      ...(signal ? { signal } : {}),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new ExamApiError(safeProblems[response.status] ?? fallbackProblem, response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new ExamApiError(fallbackProblem);
    }
  }
}

export function createExamApi(
  baseUrl: string,
  csrfTokenProvider: CsrfTokenProvider,
  fetchImpl?: FetchLike,
): ExamApi {
  return new BrowserExamApi(baseUrl, csrfTokenProvider, fetchImpl);
}
