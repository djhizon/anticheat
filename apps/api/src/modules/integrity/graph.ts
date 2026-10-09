import type { ApiConfig } from '../../config.js';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

/**
 * Gets a Microsoft Graph Bearer token using Client Credentials flow.
 * Caches the token in memory until it expires.
 */
async function getGraphToken(config: ApiConfig): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { msTenantId, msClientId, msClientSecret } = config;
  if (!msTenantId || !msClientId || !msClientSecret) {
    throw new Error('Microsoft Graph credentials are not fully configured in the environment.');
  }

  const tokenUrl = `https://login.microsoftonline.com/${msTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: msClientId,
    scope: 'https://graph.microsoft.com/.default',
    client_secret: msClientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to acquire Microsoft Graph token: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;

  return cachedToken;
}

/** True when every setting needed to upload recording segments is present. */
export function isRecordingUploadConfigured(config: ApiConfig): boolean {
  return Boolean(
    config.msTenantId && config.msClientId && config.msClientSecret && config.msTargetEmail,
  );
}

/** The segment already exists in OneDrive; uploads never overwrite. */
export class RecordingConflictError extends Error {
  constructor() {
    super('Recording segment already exists.');
    this.name = 'RecordingConflictError';
  }
}

const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, '_');

/** OneDrive path of one recording segment, sortable by index. */
export function recordingSegmentPath(
  studentId: string,
  attemptId: string,
  segmentIndex: number,
): string {
  const padded = segmentIndex.toString().padStart(6, '0');
  return `/ExamGuard/${safeSegment(studentId)}/${safeSegment(attemptId)}/segment-${padded}.webm`;
}

/**
 * Uploads one recording segment to the target user's OneDrive under:
 * /ExamGuard/{studentId}/{attemptId}/segment-{index}.webm
 */
export async function uploadRecordingChunk(
  config: ApiConfig,
  studentId: string,
  attemptId: string,
  chunkIndex: number,
  buffer: Buffer,
): Promise<void> {
  const { msTargetEmail } = config;
  if (!msTargetEmail) {
    throw new Error('MS_RECORDING_TARGET_EMAIL is not configured.');
  }

  const token = await getGraphToken(config);
  const path = recordingSegmentPath(studentId, attemptId, chunkIndex);

  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(msTargetEmail)}/drive/root:${path}:/content?@microsoft.graph.conflictBehavior=fail`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/webm',
    },
    body: new Uint8Array(buffer),
  });

  if (!response.ok) {
    if (response.status === 409) throw new RecordingConflictError();
    // Status only: Graph error bodies stay out of errors that may be logged or surfaced.
    throw new Error(`Failed to upload chunk to Microsoft Graph: ${response.status}`);
  }
}

/**
 * Best-effort removal of uploaded segments once their metadata was swept (retention or the
 * "marked fine" purge). Missing files (404) count as removed; other failures are reported once.
 */
export async function deleteRecordingSegments(
  config: ApiConfig,
  segments: ReadonlyArray<{
    readonly student_id: string;
    readonly attempt_id: string;
    readonly segment_index: number;
  }>,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const { msTargetEmail } = config;
  if (!msTargetEmail || segments.length === 0) return 0;
  const token = await getGraphToken(config);
  let removed = 0;
  let failed = 0;
  for (const segment of segments) {
    const path = recordingSegmentPath(
      segment.student_id,
      segment.attempt_id,
      segment.segment_index,
    );
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(msTargetEmail)}/drive/root:${path}`;
    try {
      const response = await fetchImpl(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok || response.status === 404) removed += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    // Counts only: never log paths or Graph error bodies.
    console.warn(`[retention] ${failed} uploaded recording segment(s) could not be removed.`);
  }
  return removed;
}
