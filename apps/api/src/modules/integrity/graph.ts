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
    const text = await response.text();
    throw new Error(`Failed to acquire Microsoft Graph token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;

  return cachedToken;
}

/**
 * Uploads a chunk of recording to the target user's OneDrive under:
 * /ExamAntiCheat/{examId}/{attemptId}/{filename}
 */
export async function uploadRecordingChunk(
  config: ApiConfig,
  examId: string,
  attemptId: string,
  chunkIndex: number,
  buffer: Buffer,
): Promise<void> {
  const { msTargetEmail } = config;
  if (!msTargetEmail) {
    throw new Error('MS_RECORDING_TARGET_EMAIL is not configured.');
  }

  const token = await getGraphToken(config);

  // Format chunk index to be 001, 002, etc. so they sort alphabetically
  const paddedIndex = chunkIndex.toString().padStart(3, '0');
  const filename = `recording_${paddedIndex}.webm`;
  const path = `/ExamAntiCheat/exam_${examId}/attempt_${attemptId}/${filename}`;

  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(msTargetEmail)}/drive/root:${path}:/content`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/webm',
    },
    body: new Uint8Array(buffer),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload chunk to Microsoft Graph: ${response.status} ${text}`);
  }
}
