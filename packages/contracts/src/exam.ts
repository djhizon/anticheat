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
  /** True while pre-exam setup is unfinished: no timer yet and no questions delivered. */
  readonly awaitingStart?: boolean;
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

export const EVIDENCE_SOURCES = ['webcam', 'screen', 'desk_camera'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Why a snapshot was taken. Shared by the laptop client, the iPhone app and the API. */
export const EVIDENCE_TRIGGERS = [
  'multiple_faces',
  'no_face',
  'phone_detected',
  'look_away',
  'overlay_detected',
  'disallowed_app_foreground',
  'extra_person',
  'left_frame',
  'hands_not_visible',
  'text_injected',
] as const;
export type EvidenceTrigger = (typeof EVIDENCE_TRIGGERS)[number];

/** Limits enforced by the API and mirrored by clients. */
export const EVIDENCE_MAX_BYTES = 300 * 1024;
export const EVIDENCE_MIN_GAP_MS = 30_000;
export const EVIDENCE_MAX_PER_ATTEMPT = 60;

export interface EvidenceSnapshotMeta {
  readonly id: string;
  readonly source: EvidenceSource;
  readonly trigger: EvidenceTrigger;
  readonly capturedAt: string;
}

export interface EvidenceListResponse {
  readonly snapshots: readonly EvidenceSnapshotMeta[];
}

export interface EvidenceUploadRequest {
  readonly source: EvidenceSource;
  readonly trigger: EvidenceTrigger;
  readonly capturedAt: string;
  readonly imageJpegBase64: string;
}

export interface TranscriptEntry {
  readonly capturedAt: string;
  readonly text: string;
}

export interface TranscriptResponse {
  readonly entries: readonly TranscriptEntry[];
}

export interface TransparencyReportResponse {
  readonly events: readonly TransparencyEvent[];
}

/** Where a unified integrity-log entry came from. */
export const INTEGRITY_TIMELINE_SOURCES = [
  'camera',
  'gaze',
  'audio',
  'transcript',
  'keyboard',
  'pointer',
  'browser',
  'desktop',
  'phone',
  'liveness',
  'answer',
  'system',
] as const;
export type IntegrityTimelineSource = (typeof INTEGRITY_TIMELINE_SOURCES)[number];

/**
 * One aggregated input-behaviour window (15-30 s) uploaded in the telemetry batch.
 * Numbers only: never which keys were pressed and never raw pointer coordinates.
 */
export interface InputBehaviourWindow {
  readonly windowStart: number;
  readonly windowMs: number;
  readonly pointerEvents: number;
  readonly pointerLeaves: number;
  readonly pointerOutsideMs: number;
  readonly longestOutsideMs: number;
  readonly outsideEdge: 'left' | 'right' | 'top' | 'bottom' | null;
  readonly untrustedEvents: number;
  readonly teleports: number;
  readonly roboticSegments: number;
  readonly pathStraightness: number | null;
  readonly velocityCv: number | null;
  readonly contextMenus: number;
  readonly selections: number;
  readonly keys: number;
  readonly chars: number;
  readonly corrections: number;
  readonly meanDwellMs: number | null;
  readonly meanIntervalMs: number | null;
  readonly intervalCv: number | null;
  readonly wpm: number | null;
  readonly injections: number;
  readonly idlePointerInjections: number;
  readonly driftZDwell: number | null;
  readonly driftZInterval: number | null;
}

/** Notable-pattern events the browser reports through the events endpoint. */
export const INPUT_BEHAVIOUR_EVENTS = [
  'pointer_outside_long',
  'synthetic_input',
  'drop_blocked',
  'copy_question',
  'text_injected',
  'uniform_typing',
  'burst_after_idle',
  'typing_drift',
] as const;
export type InputBehaviourEvent = (typeof INPUT_BEHAVIOUR_EVENTS)[number];
export type IntegrityTimelineSeverity = 'info' | 'notice' | 'flag';

/**
 * One normalized entry of the per-attempt integrity log. `summary` is plain,
 * non-accusatory wording: entries are leads for a human, never verdicts.
 * `data` holds small structured facts only (never images, audio, or answers).
 */
export interface IntegrityTimelineEntry {
  readonly at: string;
  readonly source: IntegrityTimelineSource;
  readonly kind: string;
  readonly severity: IntegrityTimelineSeverity;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface IntegrityTimelineResponse {
  readonly entries: readonly IntegrityTimelineEntry[];
}

/** One attempt in the instructor's review list. */
export interface InstructorAttemptSummary {
  readonly id: string;
  readonly studentEmail: string;
  readonly examTitle: string;
  readonly status: 'in_progress' | 'submitted' | 'expired';
  readonly startedAt: string;
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

/** What this server can do for instructors, so the UI can disable what would only fail. */
export interface InstructorCapabilities {
  /** True when GEMINI_API_KEYS is set (similarity and AI-answer checks need it). */
  readonly gemini: boolean;
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
  /** Optional, additive (newer phones). Debounced on-device; counts and label names only. */
  readonly extraPerson?: boolean;
  readonly extraHands?: boolean;
  readonly handCount?: number;
  readonly leftHands?: number;
  readonly rightHands?: number;
  readonly textVisible?: boolean;
  readonly objectHints?: readonly string[];
  readonly cameraObstructed?: boolean;
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
