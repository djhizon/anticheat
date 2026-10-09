import type { InstructorAttemptSummary } from '@examguard/contracts/exam';
import type {
  AttemptFindings,
  Finding,
  ReviewDecision,
  ReviewDecisionRequest,
  ReviewLevel,
} from '@examguard/contracts/findings';

import type { FetchLike } from '../auth/api.js';

/**
 * One row of GET /exam/instructor/attempts. Triage and privacy fields are optional on the client so
 * an older server (without the findings engine or retention settings) still renders.
 */
export interface TriageAttemptRow extends Omit<
  InstructorAttemptSummary,
  'level' | 'topReason' | 'findingCount' | 'privacy'
> {
  readonly level?: ReviewLevel;
  readonly topReason?: string | null;
  readonly findingCount?: number;
  readonly decision?: ReviewDecision | null;
  readonly privacy?: InstructorAttemptSummary['privacy'];
}

export interface FindingsApi {
  /** Resolves to null when the server has no findings for the attempt yet (404). */
  getFindings(attemptId: string): Promise<AttemptFindings | null>;
}

export interface TriageApi extends FindingsApi {
  listAttempts(): Promise<readonly TriageAttemptRow[]>;
  decide(attemptId: string, request: ReviewDecisionRequest): Promise<ReviewDecision>;
}

export interface FindingNotesApi extends FindingsApi {
  saveNote(attemptId: string, findingId: string, note: string): Promise<void>;
}

export class FindingsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FindingsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const levels = new Set<string>(['none', 'glance', 'review']);
const confidences = new Set<string>(['low', 'medium', 'high']);

function parseFinding(value: unknown): Finding | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.title !== 'string' ||
    !confidences.has(String(value.confidence))
  ) {
    return null;
  }
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  const windows = Array.isArray(value.windows)
    ? value.windows.filter(
        (item): item is { start: string; end: string } =>
          isRecord(item) && typeof item.start === 'string' && typeof item.end === 'string',
      )
    : [];
  const transcript = Array.isArray(value.transcript)
    ? value.transcript.filter(
        (item): item is { at: string; text: string } =>
          isRecord(item) && typeof item.at === 'string' && typeof item.text === 'string',
      )
    : [];
  return {
    id: value.id,
    type: value.type as Finding['type'],
    confidence: value.confidence as Finding['confidence'],
    title: value.title,
    reasons: strings(value.reasons),
    windows,
    evidenceIds: strings(value.evidenceIds),
    transcript,
    studentNote: typeof value.studentNote === 'string' ? value.studentNote : null,
  };
}

export function parseAttemptFindings(body: unknown): AttemptFindings {
  if (
    !isRecord(body) ||
    typeof body.attemptId !== 'string' ||
    !levels.has(String(body.level)) ||
    !Array.isArray(body.findings)
  ) {
    throw new FindingsApiError('Unexpected response.', 200);
  }
  return {
    attemptId: body.attemptId,
    level: body.level as ReviewLevel,
    findings: body.findings
      .map(parseFinding)
      .filter((finding): finding is Finding => finding !== null),
    topReason: typeof body.topReason === 'string' ? body.topReason : null,
  };
}

function findingsPath(root: string, attemptId: string): string {
  return `${root}/exam/attempts/${encodeURIComponent(attemptId)}/findings`;
}

async function fetchFindings(
  fetchImpl: FetchLike,
  root: string,
  attemptId: string,
): Promise<AttemptFindings | null> {
  const response = await fetchImpl(findingsPath(root, attemptId), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  // The findings route may not be deployed yet, or the attempt has no engine output: not an error.
  if (response.status === 404) return null;
  if (!response.ok) throw new FindingsApiError('Findings could not be loaded.', response.status);
  return parseAttemptFindings(await response.json());
}

/** Instructor side: attempt rows with triage fields, findings per attempt, and decisions. */
export function createTriageApi(
  csrfTokenProvider: () => Promise<string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  baseUrl = '',
): TriageApi {
  const root = baseUrl.replace(/\/$/u, '');
  return {
    async listAttempts() {
      const response = await fetchImpl(`${root}/exam/instructor/attempts`, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok)
        throw new FindingsApiError('Attempts could not be loaded.', response.status);
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.attempts))
        throw new FindingsApiError('Unexpected response.', response.status);
      return body.attempts.filter(
        (row): row is TriageAttemptRow =>
          isRecord(row) && typeof row.id === 'string' && typeof row.studentEmail === 'string',
      );
    },
    getFindings: (attemptId) => fetchFindings(fetchImpl, root, attemptId),
    async decide(attemptId, request) {
      const response = await fetchImpl(
        `${root}/exam/instructor/attempts/${encodeURIComponent(attemptId)}/decision`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': await csrfTokenProvider(),
          },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok)
        throw new FindingsApiError('The decision could not be saved.', response.status);
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body.decision))
        throw new FindingsApiError('Unexpected response.', response.status);
      return body.decision as unknown as ReviewDecision;
    },
  };
}

/** Student side: own findings and a note per finding. */
export function createFindingNotesApi(
  csrfTokenProvider: () => Promise<string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  baseUrl = '',
): FindingNotesApi {
  const root = baseUrl.replace(/\/$/u, '');
  return {
    getFindings: (attemptId) => fetchFindings(fetchImpl, root, attemptId),
    async saveNote(attemptId, findingId, note) {
      const response = await fetchImpl(
        `${findingsPath(root, attemptId)}/${encodeURIComponent(findingId)}/note`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': await csrfTokenProvider(),
          },
          body: JSON.stringify({ note }),
        },
      );
      if (!response.ok) throw new FindingsApiError('Your note was not saved.', response.status);
    },
  };
}
