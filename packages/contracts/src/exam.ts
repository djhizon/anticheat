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

/** One pair of students whose answers to the same question are semantically close. */
export interface SimilarityPair {
  readonly studentAId: string;
  readonly studentBId: string;
  readonly score: number; // 0.0 – 1.0 cosine similarity
  readonly flagged: boolean; // score > threshold
}

/** Instructor-only collusion report for one question. */
export interface SimilarityReportResponse {
  readonly questionId: string;
  readonly pairs: readonly SimilarityPair[];
  readonly threshold: number;
  readonly generatedAt: string;
}

/** One entry in the student-facing record of what monitoring captured. */
export interface TransparencyEvent {
  readonly timestamp: string;
  readonly type: 'HARDWARE' | 'SOFTWARE' | 'VISION' | 'GAZE' | 'AUDIO';
  readonly severity: 'low' | 'medium' | 'high';
  readonly description: string;
}

export interface TransparencyReportResponse {
  readonly events: readonly TransparencyEvent[];
}

/** Instructor view of a published exam version and its free-text questions. */
export interface InstructorExamVersion {
  readonly id: string;
  readonly title: string;
  readonly versionNumber: number;
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly type: string;
  }[];
}

export interface InstructorExamVersionsResponse {
  readonly versions: readonly InstructorExamVersion[];
}

export interface SimilarityRunResponse {
  readonly report: SimilarityReportResponse;
  /** Student id → email, so instructors can recognise who wrote each answer. */
  readonly students: Readonly<Record<string, string>>;
}

/** Gemini's read on whether one student's answer looks AI-generated. */
export interface AiCheckResult {
  readonly studentId: string;
  readonly email: string;
  /** 0.0 clearly human … 1.0 very likely AI. Meaningless when `available` is false. */
  readonly score: number;
  readonly flags: readonly { readonly phrase: string; readonly reason: string }[];
  readonly summary: string;
  readonly available: boolean;
}

export interface AiCheckRunResponse {
  readonly questionId: string;
  readonly checkedAt: string;
  readonly results: readonly AiCheckResult[];
  /** True when more answers existed than one run checks. */
  readonly truncated: boolean;
}

/**
 * Camera labels of software/virtual sources (OBS, phone-as-webcam apps, effect
 * filters). Exams accept only a native hardware webcam; both the browser and
 * the API reject these. Labels are a strong heuristic, not hardware attestation.
 */
export const VIRTUAL_CAMERA_LABEL =
  /obs|virtual|camtwist|snap camera|manycam|epoccam|ndi|xsplit|mmhmm|camo\b|droidcam|ivcam|iriun|nvidia broadcast|splitcam|youcam|vcam|e2esoft|logi capture|streamlabs|chromacam|webcamoid|screen capture/i;

/** Flags-only desk-camera status computed on the student's iPhone. No images. */
export interface DeskCameraStatus {
  readonly people: number;
  readonly handsVisible: boolean;
  readonly framingOk: boolean;
}

/** Liveness challenge kinds. `colour_flash` is the default; the others are opt-in. */
export type LivenessChallengeType = 'colour_flash' | 'head_turn' | 'spoken_words';
export type LivenessColour = 'red' | 'green' | 'blue';
export type LivenessTurnDirection = 'left' | 'right';
export interface LivenessRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}
export interface LivenessYawSample {
  /** Milliseconds since the first sample. */
  readonly t: number;
  /** Degrees relative to the starting pose; positive is the student's right. */
  readonly yaw: number;
}
