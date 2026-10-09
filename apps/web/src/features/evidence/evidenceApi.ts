import type { EvidenceSnapshotMeta, EvidenceUploadRequest } from '@exam-anti-cheat/contracts/exam';

import type { FetchLike } from '../auth/api.js';

export interface EvidenceApi {
  postEvidence(attemptId: string, request: EvidenceUploadRequest): Promise<void>;
  listEvidence(attemptId: string): Promise<readonly EvidenceSnapshotMeta[]>;
  /** Fetches the JPEG with the session cookie and returns a blob: URL (caller revokes it). */
  loadEvidenceImage(attemptId: string, id: string): Promise<string>;
}

export class EvidenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EvidenceApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One implementation for students (own attempt) and instructors (any attempt). */
export function createEvidenceApi(
  baseUrl: string,
  csrfTokenProvider: () => Promise<string>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): EvidenceApi {
  const root = baseUrl.replace(/\/$/u, '');
  const base = (attemptId: string) =>
    `${root}/exam/attempts/${encodeURIComponent(attemptId)}/evidence`;
  return {
    async postEvidence(attemptId, request) {
      const response = await fetchImpl(base(attemptId), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': await csrfTokenProvider(),
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new EvidenceApiError('Evidence was not saved.', response.status);
    },
    async listEvidence(attemptId) {
      const response = await fetchImpl(base(attemptId), {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok)
        throw new EvidenceApiError('Evidence could not be loaded.', response.status);
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.snapshots)) {
        throw new EvidenceApiError('Unexpected response.', response.status);
      }
      return body.snapshots.filter(
        (item): item is EvidenceSnapshotMeta =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.source === 'string' &&
          typeof item.trigger === 'string' &&
          typeof item.capturedAt === 'string',
      );
    },
    async loadEvidenceImage(attemptId, id) {
      const response = await fetchImpl(`${base(attemptId)}/${encodeURIComponent(id)}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new EvidenceApiError('Image could not be loaded.', response.status);
      return URL.createObjectURL(await response.blob());
    },
  };
}
