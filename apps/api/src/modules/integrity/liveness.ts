import { createHash, randomBytes } from 'node:crypto';

export const CHALLENGE_TTL_MS = 90_000;
export const FLASH_BRIGHTNESS_THRESHOLD = 8.0;
export const JITTER_THRESHOLD = 0.15;
export const NOISE_THRESHOLD = 3.0;

export const GESTURE_CHALLENGES = ['fingers_1', 'fingers_2', 'fingers_3', 'thumbs_up'] as const;
export type GestureChallenge = (typeof GESTURE_CHALLENGES)[number];

const GESTURE_LABELS: Record<GestureChallenge, string> = { fingers_1: 'Hold up 1 finger', fingers_2: 'Hold up 2 fingers', fingers_3: 'Hold up 3 fingers', thumbs_up: 'Give a thumbs up' };



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

/** HMAC-based nonce signing so the client can't forge challenges */
export function signNonce(nonce: string, secret: string): string {
  return createHash('sha256').update(`${nonce}:${secret}`).digest('hex').slice(0, 16);
}
