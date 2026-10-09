import { createHash } from 'node:crypto';

import {
  DomainError,
  type AttemptId,
  type Clock,
  type ExamId,
  type Opaque,
  type UserId,
} from '@examguard/contracts';
import type {
  ExamAnswerSaveRequest,
  ExamAnswerSaveResponse,
  AssignmentId,
  ExamAssignmentListResponse,
  ExamAssignmentProjection,
  ExamDeliveryProjection,
  ExamSubmitRequest,
  ExamSubmitResponse,
  ExamQuestionProjection,
  ExamVersionId,
  QuestionOption,
  QuestionType,
  ExamAnswerValue,
  ExamGenerationResponse,
  ExamGenerationSource,
} from '@examguard/contracts/exam';

import type { TokenGenerator } from '../auth/session.js';
import {
  createFallbackExamQuestions,
  generateExamQuestions,
  type GenerateQuestionsOptions,
  type GeneratedQuestion,
} from '../integrity/questionGenerator.js';
import {
  ExamRepository,
  type ExamAssignmentListRecord,
  type ExamDeliveryRecord,
  type ExamQuestionRecord,
} from './exam.repository.js';

export const MAX_EXTRA_TIME_SECONDS = 24 * 60 * 60;
const MAX_EXAM_DURATION_SECONDS = 24 * 60 * 60;
const MAX_QUESTION_COUNT = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ANSWER_TEXT_LENGTH = 10000;
const FRESH_EXAM_QUESTION_COUNT = 10;
const FRESH_EXAM_DURATION_SECONDS = 60 * 60;
const FRESH_EXAM_TOPIC =
  'Computer Science fundamentals — networking, algorithms, databases, and security';

export interface SeedQuestionInput {
  readonly type: QuestionType;
  readonly prompt: string;
  readonly options?: readonly QuestionOption[];
  readonly answerKey: unknown;
}

export interface SeedPublishedExamInput {
  readonly examId?: ExamId;
  readonly slug?: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly durationSeconds: number;
  readonly questions: readonly SeedQuestionInput[];
}

export interface AssignExamInput {
  readonly examVersionId: ExamVersionId;
  readonly studentId: UserId;
  readonly extraTimeSeconds?: number;
}

export interface SeedPublishedExamResult {
  readonly examId: ExamId;
  readonly examVersionId: ExamVersionId;
  readonly versionNumber: number;
}

export interface StartAttemptResult {
  readonly delivery: ExamDeliveryProjection;
  readonly created: boolean;
}

export interface FreshExamGenerationOptions {
  readonly geminiKeys?: readonly string[];
  readonly geminiModel?: string;
  readonly geminiEmbeddingModel?: string;
}

export type ExamQuestionGenerator = (
  apiKeys: readonly string[],
  options: GenerateQuestionsOptions,
) => Promise<{ questions: readonly GeneratedQuestion[]; estimatedDurationSeconds: number }>;

export interface ExamServiceDependencies {
  readonly repository: ExamRepository;
  readonly clock: Clock;
  readonly idGenerator: TokenGenerator;
  readonly questionGenerator?: ExamQuestionGenerator;
  readonly assertPhoneCanAnswer?: (attemptId: string) => void;
}

interface NormalizedQuestion {
  readonly type: QuestionType;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly answerKeyJson: string;
}

function asExamOpaque<Brand extends string>(value: string): Opaque<string, Brand> {
  if (value.trim() === '') {
    throw new Error('Exam identifiers must not be empty.');
  }
  return value as Opaque<string, Brand>;
}

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized === '' || normalized.length > maxLength) {
    throw new DomainError('validation_failed', `${field} is invalid.`);
  }
  return normalized;
}

function validatePositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DomainError('validation_failed', `${field} is invalid.`);
  }
  return value;
}

function validateExtraTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EXTRA_TIME_SECONDS) {
    throw new DomainError('validation_failed', 'Extra-time accommodation is invalid.');
  }
  return value;
}

function normalizeOptions(options: readonly QuestionOption[]): readonly QuestionOption[] {
  if (options.length < 2 || options.length > 100) {
    throw new DomainError('validation_failed', 'Multiple-choice options are invalid.');
  }

  const ids = new Set<string>();
  return options.map((option) => {
    const id = requireText(option.id, 'Option ID', 100);
    const text = requireText(option.text, 'Option text', 2000);
    if (ids.has(id)) {
      throw new DomainError('validation_failed', 'Multiple-choice option IDs must be unique.');
    }
    ids.add(id);
    return { id, text };
  });
}

function normalizeQuestion(input: SeedQuestionInput): NormalizedQuestion {
  const prompt = requireText(input.prompt, 'Question prompt', 10000);
  const inputOptions = input.options ?? [];
  let options: readonly QuestionOption[] = [];
  let answerKey: unknown = input.answerKey;

  switch (input.type) {
    case 'multiple_choice':
      options = normalizeOptions(inputOptions);
      if (
        typeof input.answerKey !== 'string' ||
        !options.some((option) => option.id === input.answerKey)
      ) {
        throw new DomainError('validation_failed', 'The multiple-choice answer is invalid.');
      }
      break;
    case 'true_false':
      if (inputOptions.length > 0 || typeof input.answerKey !== 'boolean') {
        throw new DomainError('validation_failed', 'The true/false question is invalid.');
      }
      break;
    case 'identification':
    case 'short_answer':
      if (inputOptions.length > 0 || typeof input.answerKey !== 'string') {
        throw new DomainError('validation_failed', 'The text question is invalid.');
      }
      answerKey = requireText(input.answerKey, 'Answer key', 10000);
      break;
    case 'numeric':
      if (
        inputOptions.length > 0 ||
        typeof input.answerKey !== 'number' ||
        !Number.isFinite(input.answerKey)
      ) {
        throw new DomainError('validation_failed', 'The numeric question is invalid.');
      }
      break;
    default:
      throw new DomainError('validation_failed', 'The question type is not supported.');
  }

  return {
    type: input.type,
    prompt,
    options,
    answerKeyJson: JSON.stringify(answerKey),
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

function parseTimestamp(value: string, message: string): number {
  const timestampMillis = Date.parse(value);
  if (!Number.isFinite(timestampMillis)) {
    throw new DomainError('invalid_state', message);
  }
  return timestampMillis;
}

function isDue(deadline: string, now: Date): boolean {
  const deadlineMillis = parseTimestamp(deadline, 'The attempt deadline is invalid.');
  return deadlineMillis <= now.getTime();
}

function isAssignedInFuture(assignedAt: string, now: Date): boolean {
  const assignedAtMillis = parseTimestamp(assignedAt, 'The assignment timestamp is invalid.');
  return assignedAtMillis > now.getTime();
}

function requireIdempotencyKey(value: string): string {
  if (value.trim() !== value || value.length < 16 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new DomainError('validation_failed', 'The idempotency key is invalid.');
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function operationHash(operation: string, value: unknown): string {
  return createHash('sha256')
    .update(operation)
    .update('\0')
    .update(canonicalJson(value))
    .digest('hex');
}

function readStoredResponse<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new DomainError('invalid_state', 'The stored exam response is invalid.');
  }
}

function validateAnswerValue(
  question: ExamQuestionRecord,
  value: ExamAnswerValue,
): ExamAnswerValue {
  if (value === null) {
    return null;
  }
  switch (question.type) {
    case 'multiple_choice':
      if (typeof value !== 'string' || !question.options.some((option) => option.id === value)) {
        throw new DomainError('validation_failed', 'An answer does not match its question.');
      }
      return value;
    case 'true_false':
      if (typeof value !== 'boolean') {
        throw new DomainError('validation_failed', 'An answer does not match its question.');
      }
      return value;
    case 'numeric':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DomainError('validation_failed', 'An answer does not match its question.');
      }
      return value;
    case 'identification':
    case 'short_answer':
      if (typeof value !== 'string' || value.length > MAX_ANSWER_TEXT_LENGTH) {
        throw new DomainError('validation_failed', 'An answer does not match its question.');
      }
      return value;
    default:
      throw new DomainError('validation_failed', 'An answer does not match its question.');
  }
}

function validateAnswerSnapshot(
  request: ExamAnswerSaveRequest,
  questions: readonly ExamQuestionRecord[],
): Readonly<Record<string, ExamAnswerValue>> {
  if (
    typeof request.answers !== 'object' ||
    request.answers === null ||
    Array.isArray(request.answers)
  ) {
    throw new DomainError('validation_failed', 'The answer snapshot is invalid.');
  }
  const questionIds = new Set(questions.map((question) => String(question.id)));
  const answerIds = Object.keys(request.answers);
  if (answerIds.length !== questions.length || answerIds.some((id) => !questionIds.has(id))) {
    throw new DomainError('validation_failed', 'The answer snapshot does not match the exam.');
  }

  const normalized: Record<string, ExamAnswerValue> = {};
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(request.answers, question.id)) {
      throw new DomainError('validation_failed', 'The answer snapshot is incomplete.');
    }
    const answer = request.answers[question.id];
    if (answer === undefined) {
      throw new DomainError('validation_failed', 'The answer snapshot is incomplete.');
    }
    normalized[question.id] = validateAnswerValue(question, answer);
  }
  return normalized;
}

function answerHashValue(answers: Readonly<Record<string, ExamAnswerValue>>): readonly unknown[] {
  return Object.entries(answers).sort(([left], [right]) => left.localeCompare(right));
}

function stableOrderingKey(seed: string, scope: string, id: string): string {
  return createHash('sha256')
    .update(seed)
    .update('\0')
    .update(scope)
    .update('\0')
    .update(id)
    .digest('hex');
}

function stableOrder<T extends { readonly id: string }>(
  seed: string,
  scope: string,
  values: readonly T[],
): readonly T[] {
  return [...values].sort((left, right) => {
    const comparison = stableOrderingKey(seed, scope, left.id).localeCompare(
      stableOrderingKey(seed, scope, right.id),
    );
    return comparison === 0 ? left.id.localeCompare(right.id) : comparison;
  });
}

export class ExamService {
  constructor(private readonly dependencies: ExamServiceDependencies) {}

  /** Synthetic fixture/publisher boundary; Pack 2 exposes no unauthenticated seed route. */
  async seedPublishedExam(input: SeedPublishedExamInput): Promise<SeedPublishedExamResult> {
    const title = requireText(input.title, 'Exam title', 500);
    const versionNumber = validatePositiveInteger(input.versionNumber, 'Exam version', 1000000);
    const durationSeconds = validatePositiveInteger(
      input.durationSeconds,
      'Exam duration',
      MAX_EXAM_DURATION_SECONDS,
    );
    if (input.questions.length === 0 || input.questions.length > MAX_QUESTION_COUNT) {
      throw new DomainError('validation_failed', 'The exam question list is invalid.');
    }
    const questions = input.questions.map(normalizeQuestion);
    const examId =
      input.examId ?? asExamOpaque<'ExamId'>(this.dependencies.idGenerator.generate(16));
    const examVersionId = asExamOpaque<'ExamVersionId'>(this.dependencies.idGenerator.generate(16));
    const createdAt = this.dependencies.clock.now().toISOString();

    try {
      return await this.dependencies.repository.withTransaction(async () => {
        const existingExam = this.dependencies.repository.findExamById(examId);
        if (existingExam === null) {
          if (input.slug === undefined) {
            throw new DomainError('validation_failed', 'A new exam requires a slug.');
          }
          this.dependencies.repository.insertExam({
            id: examId,
            slug: requireText(input.slug, 'Exam slug', 64),
            createdAt,
          });
        }

        this.dependencies.repository.insertExamVersion({
          id: examVersionId,
          examId,
          versionNumber,
          title,
          durationSeconds,
          status: 'draft',
          createdAt,
          publishedAt: null,
        });

        for (const [position, question] of questions.entries()) {
          const questionVersionId = asExamOpaque<'QuestionVersionId'>(
            this.dependencies.idGenerator.generate(16),
          );
          this.dependencies.repository.insertQuestionVersion({
            id: questionVersionId,
            type: question.type,
            prompt: question.prompt,
            optionsJson: JSON.stringify(question.options),
            answerKeyJson: question.answerKeyJson,
            createdAt,
          });
          this.dependencies.repository.insertExamVersionQuestion(
            examVersionId,
            questionVersionId,
            position,
          );
        }

        this.dependencies.repository.publishExamVersion(examVersionId, createdAt);
        return { examId, examVersionId, versionNumber };
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new DomainError('conflict', 'The exam version already exists.');
      }
      throw error;
    }
  }

  /**
   * Generates and assigns a brand-new exam without mutating prior exam history.
   * Provider calls finish before the short database transaction begins.
   */
  async generateFreshExamForStudent(
    studentId: UserId,
    options: FreshExamGenerationOptions = {},
  ): Promise<ExamGenerationResponse> {
    if (!this.dependencies.repository.isStudent(studentId)) {
      throw new DomainError('forbidden', 'Only student accounts can receive assignments.');
    }

    let source: ExamGenerationSource = 'fallback';
    let questions: readonly GeneratedQuestion[] = createFallbackExamQuestions();
    let durationSeconds = FRESH_EXAM_DURATION_SECONDS;
    const geminiKeys = options.geminiKeys ?? [];

    if (geminiKeys.length > 0) {
      try {
        const generated = await (this.dependencies.questionGenerator ?? generateExamQuestions)(
          geminiKeys,
          {
            topic: FRESH_EXAM_TOPIC,
            count: FRESH_EXAM_QUESTION_COUNT,
            difficulty: 'medium',
            types: ['multiple_choice', 'true_false', 'identification', 'short_answer', 'numeric'],
            ...(options.geminiModel === undefined ? {} : { model: options.geminiModel }),
            ...(options.geminiEmbeddingModel === undefined
              ? {}
              : { embeddingModel: options.geminiEmbeddingModel }),
          },
        );
        questions = generated.questions;
        durationSeconds = generated.estimatedDurationSeconds;
        source = 'gemini';
      } catch {
        // A clearly labelled fallback keeps the local classroom demo usable.
        questions = createFallbackExamQuestions();
        durationSeconds = FRESH_EXAM_DURATION_SECONDS;
      }
    }

    // Plain numbering: the student's next quiz is "Quiz N".
    const quizNumber = this.dependencies.repository.listAssignmentsForStudent(studentId).length + 1;
    const title = requireText(`Quiz ${quizNumber}`, 'Exam title', 500);
    const normalizedDuration = validatePositiveInteger(
      durationSeconds,
      'Exam duration',
      MAX_EXAM_DURATION_SECONDS,
    );
    if (questions.length === 0 || questions.length > MAX_QUESTION_COUNT) {
      throw new DomainError('validation_failed', 'The exam question list is invalid.');
    }
    const normalizedQuestions = questions.map(normalizeQuestion);
    const examId = asExamOpaque<'ExamId'>(this.dependencies.idGenerator.generate(16));
    const examVersionId = asExamOpaque<'ExamVersionId'>(this.dependencies.idGenerator.generate(16));
    const assignmentId = asExamOpaque<'AssignmentId'>(this.dependencies.idGenerator.generate(16));
    const slug = requireText(
      `generated-${this.dependencies.idGenerator.generate(12)}`,
      'Exam slug',
      64,
    );
    const createdAt = this.dependencies.clock.now().toISOString();

    try {
      return await this.dependencies.repository.withTransaction(async () => {
        // Re-check inside the transaction so assignment and publication are atomic.
        if (!this.dependencies.repository.isStudent(studentId)) {
          throw new DomainError('forbidden', 'Only student accounts can receive assignments.');
        }
        this.dependencies.repository.insertExam({ id: examId, slug, createdAt });
        this.dependencies.repository.insertExamVersion({
          id: examVersionId,
          examId,
          versionNumber: 1,
          title,
          durationSeconds: normalizedDuration,
          status: 'draft',
          createdAt,
          publishedAt: null,
        });

        for (const [position, question] of normalizedQuestions.entries()) {
          const questionVersionId = asExamOpaque<'QuestionVersionId'>(
            this.dependencies.idGenerator.generate(16),
          );
          this.dependencies.repository.insertQuestionVersion({
            id: questionVersionId,
            type: question.type,
            prompt: question.prompt,
            optionsJson: JSON.stringify(question.options),
            answerKeyJson: question.answerKeyJson,
            createdAt,
          });
          this.dependencies.repository.insertExamVersionQuestion(
            examVersionId,
            questionVersionId,
            position,
          );
        }

        this.dependencies.repository.publishExamVersion(examVersionId, createdAt);
        this.dependencies.repository.insertAssignment(
          assignmentId,
          examVersionId,
          studentId,
          createdAt,
          0,
        );
        return { assignmentId, source };
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new DomainError('conflict', 'A fresh exam could not be created. Try again.');
      }
      throw error;
    }
  }

  async assignExam(input: AssignExamInput): Promise<AssignmentId> {
    const extraTimeSeconds = validateExtraTime(input.extraTimeSeconds ?? 0);
    const assignmentId = asExamOpaque<'AssignmentId'>(this.dependencies.idGenerator.generate(16));
    const assignedAt = this.dependencies.clock.now().toISOString();

    try {
      return await this.dependencies.repository.withTransaction(async () => {
        if (!this.dependencies.repository.isStudent(input.studentId)) {
          throw new DomainError('forbidden', 'Only student accounts can receive assignments.');
        }
        const version = this.dependencies.repository.findExamVersionById(input.examVersionId);
        if (version === null) {
          throw new DomainError('not_found', 'The exam version was not found.');
        }
        if (version.status !== 'published') {
          throw new DomainError('conflict', 'The exam version is not published.');
        }

        this.dependencies.repository.insertAssignment(
          assignmentId,
          input.examVersionId,
          input.studentId,
          assignedAt,
          extraTimeSeconds,
        );
        return assignmentId;
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new DomainError('conflict', 'The student already has this exam assignment.');
      }
      throw error;
    }
  }

  async listAssignments(studentId: UserId): Promise<ExamAssignmentListResponse> {
    const now = this.dependencies.clock.now().toISOString();
    return this.dependencies.repository.withTransaction(async () => {
      this.dependencies.repository.expireDueAttemptsForStudent(studentId, now);
      return {
        assignments: this.dependencies.repository
          .listAssignmentsForStudent(studentId)
          .map((record) => this.toAssignmentProjection(record)),
      };
    });
  }

  async startAttempt(assignmentId: AssignmentId, studentId: UserId): Promise<StartAttemptResult> {
    let created = false;
    const delivery = await this.dependencies.repository.withTransaction(async () => {
      const assignment = this.dependencies.repository.findAssignmentForStudent(
        assignmentId,
        studentId,
      );
      if (assignment === null) {
        throw new DomainError('not_found', 'The exam assignment was not found.');
      }

      const now = this.dependencies.clock.now();
      if (isAssignedInFuture(assignment.assignedAt, now)) {
        throw new DomainError('conflict', 'The exam assignment is not available yet.');
      }

      let attempt = this.dependencies.repository.findAttemptByAssignmentForStudent(
        assignmentId,
        studentId,
      );
      if (attempt === null) {
        const startedAt = now.toISOString();
        const baseDeadlineMillis = now.getTime() + assignment.examVersion.durationSeconds * 1000;
        const baseDeadline = new Date(baseDeadlineMillis).toISOString();
        // The persisted effective deadline is derived from the persisted base policy and bounded accommodation.
        const effectiveDeadline = new Date(
          baseDeadlineMillis + assignment.extraTimeSeconds * 1000,
        ).toISOString();
        this.dependencies.repository.insertAttempt({
          id: asExamOpaque<'AttemptId'>(this.dependencies.idGenerator.generate(16)),
          assignmentId,
          attemptSeed: this.dependencies.idGenerator.generate(32),
          startedAt,
          baseDeadline,
          effectiveDeadline,
        });
        created = true;
      } else if (attempt.status === 'in_progress' && isDue(attempt.effectiveDeadline, now)) {
        this.dependencies.repository.expireAttemptIfDue(attempt.id, now.toISOString());
      }

      attempt = this.dependencies.repository.findAttemptByAssignmentForStudent(
        assignmentId,
        studentId,
      );
      if (attempt === null) {
        throw new DomainError('invalid_state', 'The exam attempt could not be loaded.');
      }
      const record = this.dependencies.repository.findDeliveryForStudent(attempt.id, studentId);
      if (record === null) {
        throw new DomainError('invalid_state', 'The exam delivery could not be loaded.');
      }
      return this.toDeliveryProjection(record);
    });

    return { delivery, created };
  }

  async getAttemptDelivery(
    attemptId: AttemptId,
    studentId: UserId,
  ): Promise<ExamDeliveryProjection> {
    return this.dependencies.repository.withTransaction(async () => {
      const attempt = this.dependencies.repository.findAttemptForStudent(attemptId, studentId);
      if (attempt === null) {
        throw new DomainError('not_found', 'The exam attempt was not found.');
      }

      const now = this.dependencies.clock.now();
      if (attempt.status === 'in_progress' && isDue(attempt.effectiveDeadline, now)) {
        this.dependencies.repository.expireAttemptIfDue(attempt.id, now.toISOString());
      }
      const record = this.dependencies.repository.findDeliveryForStudent(attemptId, studentId);
      if (record === null) {
        throw new DomainError('invalid_state', 'The exam delivery could not be loaded.');
      }
      return this.toDeliveryProjection(record);
    });
  }

  async saveAnswers(
    attemptId: AttemptId,
    studentId: UserId,
    request: ExamAnswerSaveRequest,
  ): Promise<ExamAnswerSaveResponse> {
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const requestHash = operationHash('save_answers', {
      revision: request.revision,
      answers: answerHashValue(request.answers),
    });

    return this.dependencies.repository.withTransaction(async () => {
      const attempt = this.dependencies.repository.findAttemptForStudent(attemptId, studentId);
      if (attempt === null) {
        throw new DomainError('not_found', 'The exam attempt was not found.');
      }
      const existing = this.dependencies.repository.findAttemptMutation(
        attemptId,
        idempotencyKey,
        'save_answers',
      );
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError('conflict', 'The idempotency key was already used differently.');
        }
        return readStoredResponse<ExamAnswerSaveResponse>(existing.responseJson);
      }

      const now = this.dependencies.clock.now();
      if (attempt.status === 'in_progress' && isDue(attempt.effectiveDeadline, now)) {
        this.dependencies.repository.expireAttemptIfDue(attempt.id, now.toISOString());
        throw new DomainError('conflict', 'The exam deadline has passed.');
      }
      if (attempt.status !== 'in_progress') {
        throw new DomainError('conflict', 'The exam is no longer accepting answers.');
      }

      const questions = this.dependencies.repository.findQuestionsForVersion(
        attempt.assignment.examVersion.id,
      );
      const answers = validateAnswerSnapshot(request, questions);
      const current = this.dependencies.repository.findAnswerSnapshot(attemptId);
      if (request.revision !== current.revision) {
        throw new DomainError('conflict', 'The answer revision is stale.');
      }

      const revision = current.revision + 1;
      const savedAt = now.toISOString();
      // Inside the mutation transaction, after idempotent replay handling.
      this.dependencies.assertPhoneCanAnswer?.(attemptId);
      this.dependencies.repository.replaceAttemptAnswers(attemptId, answers, revision, savedAt);
      const response: ExamAnswerSaveResponse = { attemptId, revision, savedAt, answers };
      this.dependencies.repository.insertAttemptMutation(
        attemptId,
        idempotencyKey,
        'save_answers',
        requestHash,
        revision,
        JSON.stringify(response),
        savedAt,
      );
      return response;
    });
  }

  async submitAttemptWithAnswers(
    attemptId: AttemptId,
    studentId: UserId,
    request: ExamSubmitRequest,
  ): Promise<ExamSubmitResponse> {
    const idempotencyKey = requireIdempotencyKey(request.idempotencyKey);
    const requestHash = operationHash('submit_attempt', {
      expectedRevision: request.expectedRevision,
    });

    return this.dependencies.repository.withTransaction(async () => {
      const attempt = this.dependencies.repository.findAttemptForStudent(attemptId, studentId);
      if (attempt === null) {
        throw new DomainError('not_found', 'The exam attempt was not found.');
      }
      const existing = this.dependencies.repository.findAttemptMutation(
        attemptId,
        idempotencyKey,
        'submit_attempt',
      );
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError('conflict', 'The idempotency key was already used differently.');
        }
        return readStoredResponse<ExamSubmitResponse>(existing.responseJson);
      }

      const now = this.dependencies.clock.now();
      const current = this.dependencies.repository.findAnswerSnapshot(attemptId);
      if (attempt.status === 'in_progress' && isDue(attempt.effectiveDeadline, now)) {
        this.dependencies.repository.expireAttemptIfDue(attempt.id, now.toISOString());
      } else if (attempt.status === 'in_progress') {
        if (request.expectedRevision !== current.revision) {
          throw new DomainError('conflict', 'The answer revision is stale.');
        }
        this.dependencies.repository.submitAttemptIfActive(attempt.id, now.toISOString());
      } else {
        throw new DomainError('conflict', 'The exam has already ended.');
      }

      const record = this.dependencies.repository.findDeliveryForStudent(attemptId, studentId);
      if (record === null) {
        throw new DomainError('invalid_state', 'The exam delivery could not be loaded.');
      }
      const delivery = this.toDeliveryProjection(record);
      const receipt = {
        attemptId,
        status: delivery.attempt.status,
        revision: delivery.answers.revision,
        submittedAt: delivery.attempt.submittedAt,
        expiredAt: delivery.attempt.expiredAt,
      } satisfies ExamSubmitResponse['receipt'];
      const response: ExamSubmitResponse = { delivery, receipt };
      this.dependencies.repository.insertAttemptMutation(
        attemptId,
        idempotencyKey,
        'submit_attempt',
        requestHash,
        delivery.answers.revision,
        JSON.stringify(response),
        now.toISOString(),
      );
      return response;
    });
  }

  async submitAttempt(attemptId: AttemptId, studentId: UserId): Promise<ExamDeliveryProjection> {
    return this.dependencies.repository.withTransaction(async () => {
      const attempt = this.dependencies.repository.findAttemptForStudent(attemptId, studentId);
      if (attempt === null) {
        throw new DomainError('not_found', 'The exam attempt was not found.');
      }

      const now = this.dependencies.clock.now();
      if (attempt.status === 'in_progress') {
        if (isDue(attempt.effectiveDeadline, now)) {
          this.dependencies.repository.expireAttemptIfDue(attempt.id, now.toISOString());
        } else {
          this.dependencies.repository.submitAttemptIfActive(attempt.id, now.toISOString());
        }
      }

      const record = this.dependencies.repository.findDeliveryForStudent(attemptId, studentId);
      if (record === null) {
        throw new DomainError('invalid_state', 'The exam delivery could not be loaded.');
      }
      return this.toDeliveryProjection(record);
    });
  }

  private toAssignmentProjection(record: ExamAssignmentListRecord): ExamAssignmentProjection {
    return {
      id: record.assignment.id,
      examVersionId: record.assignment.examVersion.id,
      title: record.assignment.examVersion.title,
      versionNumber: record.assignment.examVersion.versionNumber,
      assignedAt: record.assignment.assignedAt,
      extraTimeSeconds: record.assignment.extraTimeSeconds,
      attemptId: record.attemptId,
      attemptStatus: record.attemptStatus,
    };
  }

  private toDeliveryProjection(record: ExamDeliveryRecord): ExamDeliveryProjection {
    const attempt = record.attempt;
    const examVersion = attempt.assignment.examVersion;
    const orderedQuestions = stableOrder(attempt.attemptSeed, 'questions', record.questions);

    return {
      exam: {
        id: examVersion.examId,
        versionId: examVersion.id,
        title: examVersion.title,
        versionNumber: examVersion.versionNumber,
        durationSeconds: examVersion.durationSeconds,
      },
      assignment: {
        id: attempt.assignment.id,
        examVersionId: examVersion.id,
        title: examVersion.title,
        versionNumber: examVersion.versionNumber,
        assignedAt: attempt.assignment.assignedAt,
        extraTimeSeconds: attempt.assignment.extraTimeSeconds,
        attemptId: attempt.id,
        attemptStatus: attempt.status,
      },
      attempt: {
        id: attempt.id,
        assignmentId: attempt.assignment.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        effectiveDeadline: attempt.effectiveDeadline,
        submittedAt: attempt.submittedAt,
        expiredAt: attempt.expiredAt,
      },
      answers: record.answers,
      questions: orderedQuestions.map((question) =>
        this.toQuestionProjection(attempt.attemptSeed, question),
      ),
    };
  }

  private toQuestionProjection(seed: string, question: ExamQuestionRecord): ExamQuestionProjection {
    return {
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      options: stableOrder(seed, `options:${question.id}`, question.options),
    };
  }
}
