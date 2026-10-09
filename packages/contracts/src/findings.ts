/**
 * Triage contracts: the findings engine turns an attempt's stored timeline into a few plain-language
 * findings so instructors only open attempts that need a look. Findings are leads, never verdicts.
 */

export const FINDING_TYPES = [
  'notes_or_second_screen',
  'second_person',
  'external_answer_entry',
  'phone_use',
  'left_exam',
  'environment_risk',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export type FindingConfidence = 'low' | 'medium' | 'high';

/** Overall triage level for one attempt. */
export type ReviewLevel = 'none' | 'glance' | 'review';

export const REVIEW_LEVEL_LABELS: Readonly<Record<ReviewLevel, string>> = {
  none: 'No review needed',
  glance: 'Glance',
  review: 'Review',
};

export interface FindingWindow {
  /** ISO timestamps. */
  readonly start: string;
  readonly end: string;
}

export interface Finding {
  /** Stable id: `${type}:${first window start ISO}`. */
  readonly id: string;
  readonly type: FindingType;
  readonly confidence: FindingConfidence;
  /** Short plain title, e.g. "Repeated glances to the same spot, then typing". */
  readonly title: string;
  /** Plain-language reasons, each one sentence. */
  readonly reasons: readonly string[];
  readonly windows: readonly FindingWindow[];
  /** Evidence snapshot ids related to the windows. */
  readonly evidenceIds: readonly string[];
  /** Transcript lines inside the windows (text only, already stored). */
  readonly transcript: readonly { readonly at: string; readonly text: string }[];
  /** The student's own note on this finding, if any. */
  readonly studentNote: string | null;
}

export interface AttemptFindings {
  readonly attemptId: string;
  readonly level: ReviewLevel;
  /** At most 6 findings, most important first. */
  readonly findings: readonly Finding[];
  /** Title of the most important finding, or null. */
  readonly topReason: string | null;
}

export type ReviewDecisionValue = 'fine' | 'follow_up';

export interface ReviewDecision {
  readonly attemptId: string;
  readonly decision: ReviewDecisionValue;
  readonly note: string | null;
  readonly decidedAt: string;
  readonly decidedBy: string;
}

/** Body of POST /exam/instructor/attempts/:id/decision. */
export interface ReviewDecisionRequest {
  readonly decision: ReviewDecisionValue;
  readonly note?: string;
}

/** Body of POST /exam/attempts/:id/findings/:findingId/note (student owner, ≤ 280 chars). */
export interface FindingNoteRequest {
  readonly note: string;
}

export const FINDING_NOTE_MAX = 280;
