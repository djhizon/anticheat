import type { InstructorExamVersion, SimilarityRunResponse } from '@exam-anti-cheat/contracts/exam';

import type { FetchLike } from '../auth/api.js';
import type { CsrfTokenProvider } from '../exam/api.js';

export interface InstructorApi {
  listVersions(): Promise<readonly InstructorExamVersion[]>;
  runSimilarity(versionId: string, questionId: string): Promise<SimilarityRunResponse>;
}

export class InstructorApiError extends Error {}

const problemMessages: Readonly<Record<number, string>> = {
  401: 'Your session has ended. Sign in again.',
  403: 'Only instructor accounts can review similarity.',
  404: 'That exam question could not be found.',
  500: 'The similarity check could not run. Check that GEMINI_API_KEYS is configured.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createInstructorApi(
  csrfTokenProvider: CsrfTokenProvider,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): InstructorApi {
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
  };
}
