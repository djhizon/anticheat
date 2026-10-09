import type { ExamPrivacyProjection } from '@examguard/contracts/exam';

/** Raw exam columns from migration 0015 (NULL = follow the server defaults). */
export interface ExamPrivacyRow {
  readonly retainDays: number | null;
  readonly recordingUpload: 'on' | 'off' | null;
}

/** Server-wide defaults (`AUDIO_RETAIN_DAYS`, `EVIDENCE_RETAIN_DAYS`, `RECORDING_UPLOAD`). */
export interface ExamPrivacyDefaults {
  readonly audioRetainDays: number;
  readonly evidenceRetainDays: number;
  readonly recordingUpload: boolean;
}

export const DEFAULT_EXAM_PRIVACY: ExamPrivacyDefaults = {
  audioRetainDays: 30,
  evidenceRetainDays: 30,
  recordingUpload: true,
};

/** Resolves an exam's settings against the defaults; a missing row means "all defaults". */
export function resolveExamPrivacy(
  row: ExamPrivacyRow | null,
  defaults: ExamPrivacyDefaults,
): ExamPrivacyProjection {
  const retainDays = row?.retainDays ?? null;
  return {
    retainDays,
    evidenceRetainDays: retainDays ?? defaults.evidenceRetainDays,
    transcriptRetainDays: retainDays ?? defaults.audioRetainDays,
    recordingUpload:
      row?.recordingUpload === null || row?.recordingUpload === undefined
        ? defaults.recordingUpload
        : row.recordingUpload === 'on',
  };
}
