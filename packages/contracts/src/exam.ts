import type { AttemptId, ExamId, Opaque, UserId } from './common.js';

export type ExamVersionId = Opaque<string, 'ExamVersionId'>;
export type QuestionVersionId = Opaque<string, 'QuestionVersionId'>;
export type AssignmentId = Opaque<string, 'AssignmentId'>;

export const supportedQuestionTypes = [
  'multiple_choice',
  'true_false',
  'identification',
  'numeric',
  'short_answer',
] as const;

export type QuestionType = (typeof supportedQuestionTypes)[number];
export type AttemptStatus = 'in_progress' | 'submitted' | 'expired';
export type ExamGenerationSource = 'gemini' | 'fallback';

export interface QuestionOption {
  readonly id: string;
  readonly text: string;
}

/** Student-facing question data deliberately has no answer or grading fields. */
export interface ExamQuestionProjection {
  readonly id: QuestionVersionId;
  readonly type: QuestionType;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
}

export interface ExamAssignmentProjection {
  readonly id: AssignmentId;
  readonly examVersionId: ExamVersionId;
  readonly title: string;
  readonly versionNumber: number;
  readonly assignedAt: string;
  readonly extraTimeSeconds: number;
  readonly attemptId: AttemptId | null;
  readonly attemptStatus: AttemptStatus | null;
}

export interface ExamAttemptProjection {
  readonly id: AttemptId;
  readonly assignmentId: AssignmentId;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly effectiveDeadline: string;
  readonly submittedAt: string | null;
  readonly expiredAt: string | null;
}

export type ExamAnswerValue = string | number | boolean | null;

/** Student-safe acknowledged answers; this type contains no correctness data. */
export interface ExamAnswerProjection {
  readonly revision: number;
  readonly savedAt: string | null;
  readonly answers: Readonly<Record<string, ExamAnswerValue>>;
}

export interface ExamDeliveryProjection {
  readonly exam: {
    readonly id: ExamId;
    readonly versionId: ExamVersionId;
    readonly title: string;
    readonly versionNumber: number;
    readonly durationSeconds: number;
  };
  readonly assignment: ExamAssignmentProjection;
  readonly attempt: ExamAttemptProjection;
  readonly questions: readonly ExamQuestionProjection[];
  readonly answers: ExamAnswerProjection;
}

export interface ExamAssignmentListResponse {
  readonly assignments: readonly ExamAssignmentProjection[];
}

export interface ExamGenerationResponse {
  readonly assignmentId: AssignmentId;
  readonly source: ExamGenerationSource;
}

export interface ExamDeliveryResponse {
  readonly delivery: ExamDeliveryProjection;
}

export interface ExamAnswerSaveRequest {
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly answers: Readonly<Record<string, ExamAnswerValue>>;
}

export interface ExamAnswerSaveResponse {
  readonly attemptId: AttemptId;
  readonly revision: number;
  readonly savedAt: string;
  readonly answers: Readonly<Record<string, ExamAnswerValue>>;
}

export interface ExamSubmitRequest {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface ExamSubmitResponse {
  readonly delivery: ExamDeliveryProjection;
  readonly receipt: {
    readonly attemptId: AttemptId;
    readonly status: AttemptStatus;
    readonly revision: number;
    readonly submittedAt: string | null;
    readonly expiredAt: string | null;
  };
}

export type ExamStudentId = UserId;
