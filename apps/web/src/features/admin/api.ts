import type {
  AiCheckRunResponse,
  InstructorAttemptSummary,
  InstructorExamVersion,
  InstructorCapabilities,
  IntegrityTimelineEntry,
  SimilarityRunResponse,
} from '@exam-anti-cheat/contracts/exam';

import type { FetchLike } from '../auth/api.js';
import type { CsrfTokenProvider } from '../exam/api.js';
import {
  downloadTimelineFile,
  parseTimelineEntries,
  timelineUrl,
  type IntegrityTimelineApi,
  type TimelineFormat,
} from '../integrity/timelineApi.js';

export interface InstructorApi {
  listVersions(): Promise<readonly InstructorExamVersion[]>;
  runSimilarity(versionId: string, questionId: string): Promise<SimilarityRunResponse>;
  runAiCheck(versionId: string, questionId: string): Promise<AiCheckRunResponse>;
  /** Optional so older callers keep working; absent means "assume everything is available". */
  getCapabilities?(): Promise<InstructorCapabilities>;
}

/** Attempt list plus the unified integrity log, used by the per-attempt review panel. */
export interface InstructorTimelineApi extends IntegrityTimelineApi {
  listAttempts(): Promise<readonly InstructorAttemptSummary[]>;
}

export class InstructorApiError extends Error {}

const problemMessages: Readonly<Record<number, string>> = {
  401: 'Your session has ended. Sign in again.',
  403: 'Only instructor accounts can review similarity.',
  404: 'That exam question could not be found.',
  500: 'This check could not run. Check that GEMINI_API_KEYS is configured.',
  503: 'This check needs Gemini, which is not configured on this server (GEMINI_API_KEYS).',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createInstructorApi(
  csrfTokenProvider: CsrfTokenProvider,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): InstructorApi & InstructorTimelineApi {
  async function request(path: string, method: 'GET' | 'POST'): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method === 'POST') headers['x-csrf-token'] = await csrfTokenProvider();
    const response = await fetchImpl(path, { method, headers, credentials: 'include' });
    if (!response.ok) {
      throw new InstructorApiError(
        problemMessages[response.status] ?? 'The request could not be completed.',
      );
    }
    return response.json();
  }

  return {
    async listAttempts() {
      const body = await request('/exam/instructor/attempts', 'GET');
      if (!isRecord(body) || !Array.isArray(body.attempts))
        throw new InstructorApiError('Unexpected response.');
      return body.attempts as InstructorAttemptSummary[];
    },
    async getTimeline(attemptId: string): Promise<readonly IntegrityTimelineEntry[]> {
      const body = await request(timelineUrl('', attemptId), 'GET');
      try {
        return parseTimelineEntries(body);
      } catch {
        throw new InstructorApiError('Unexpected response.');
      }
    },
    async downloadTimeline(attemptId: string, format: TimelineFormat) {
      try {
        await downloadTimelineFile(
          fetchImpl,
          timelineUrl('', attemptId, format),
          `integrity-log-${attemptId}.${format}`,
        );
      } catch {
        throw new InstructorApiError('The log could not be downloaded.');
      }
    },
    async getCapabilities() {
      const body = await request('/exam/instructor/capabilities', 'GET');
      if (!isRecord(body) || typeof body.gemini !== 'boolean')
        throw new InstructorApiError('Unexpected response.');
      return { gemini: body.gemini };
    },
    async listVersions() {
      const body = await request('/exam/instructor/versions', 'GET');
      if (!isRecord(body) || !Array.isArray(body.versions))
        throw new InstructorApiError('Unexpected response.');
      return body.versions as InstructorExamVersion[];
    },
    async runSimilarity(versionId, questionId) {
      const body = await request(
        `/exam/instructor/versions/${encodeURIComponent(versionId)}/questions/${encodeURIComponent(questionId)}/similarity`,
        'POST',
      );
      if (
        !isRecord(body) ||
        !isRecord(body.report) ||
        !Array.isArray(body.report.pairs) ||
        !isRecord(body.students)
      ) {
        throw new InstructorApiError('Unexpected response.');
      }
      return body as unknown as SimilarityRunResponse;
    },
    async runAiCheck(versionId, questionId) {
      const body = await request(
        `/exam/instructor/versions/${encodeURIComponent(versionId)}/questions/${encodeURIComponent(questionId)}/ai-check`,
        'POST',
      );
      if (!isRecord(body) || !Array.isArray(body.results) || typeof body.truncated !== 'boolean') {
        throw new InstructorApiError('Unexpected response.');
      }
      return body as unknown as AiCheckRunResponse;
    },
  };
}
