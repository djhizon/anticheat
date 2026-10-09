import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_TTL_MS = 90_000;
export const FLASH_BRIGHTNESS_THRESHOLD = 8.0;
export const JITTER_THRESHOLD = 0.15;
export const NOISE_THRESHOLD = 3.0;

export const GESTURE_CHALLENGES = ['fingers_1', 'fingers_2', 'fingers_3', 'thumbs_up'] as const;
export type GestureChallenge = (typeof GESTURE_CHALLENGES)[number];

const GESTURE_LABELS: Record<GestureChallenge, string> = {
  fingers_1: 'Hold up 1 finger',
  fingers_2: 'Hold up 2 fingers',
  fingers_3: 'Hold up 3 fingers',
  thumbs_up: 'Give a thumbs up',
};

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export type ChallengeType = 'flash' | 'gesture';

export function selectChallengeType(attemptStartedAt: string): ChallengeType {
  const ageMs = Date.now() - new Date(attemptStartedAt).getTime();
  const slot = Math.floor(ageMs / (5 * 60_000)) % 2;
  return slot === 0 ? 'flash' : 'gesture';
}

export interface GeneratedChallenge {
  readonly nonce: string;
  readonly type: ChallengeType;
  readonly data: Record<string, unknown>;
  readonly expiresAt: string;
  /** HMAC over attempt, nonce, type and expiry; the client must echo it back. */
  readonly signature?: string;
}

export function generateChallenge(type: ChallengeType): GeneratedChallenge {
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  let data: Record<string, unknown> = {};

  if (type === 'gesture') {
    const gesture = GESTURE_CHALLENGES[Math.floor(Math.random() * GESTURE_CHALLENGES.length)]!;
    data = { gesture, label: GESTURE_LABELS[gesture] };
  }

  return { nonce, type, data, expiresAt };
}

export interface VerifyResult {
  readonly passed: boolean;
  readonly detail: string;
}

export function verifyFlashChallenge(
  brightnessDelta: number,
  threshold = FLASH_BRIGHTNESS_THRESHOLD,
): VerifyResult {
  const passed = brightnessDelta >= threshold;
  return {
    passed,
    detail: passed
      ? `Face brightness increased by ${brightnessDelta.toFixed(1)} — live feed confirmed`
      : `Brightness delta ${brightnessDelta.toFixed(1)} below threshold ${threshold} — possible replay attack`,
  };
}

export function verifyGestureChallenge(
  expectedGesture: GestureChallenge,
  detectedGesture: string,
): VerifyResult {
  const passed = detectedGesture.trim().toLowerCase() === expectedGesture;
  return {
    passed,
    detail: passed
      ? `Gesture "${expectedGesture}" confirmed`
      : `Expected gesture "${expectedGesture}", received "${detectedGesture}"`,
  };
}

interface SignedFields {
  readonly attemptId: string;
  readonly nonce: string;
  readonly type: string;
  readonly expiresAt: string;
}

/**
 * HMAC-SHA256 over the challenge's identity, so a client cannot forge a
 * challenge, swap its type, extend its expiry or replay it on another attempt.
 */
export function signNonce(fields: SignedFields, secret: string): string {
  return createHmac('sha256', secret)
    .update([fields.attemptId, fields.nonce, fields.type, fields.expiresAt].join('\n'))
    .digest('base64url');
}

export function verifyNonceSignature(
  fields: SignedFields,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signNonce(fields, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
