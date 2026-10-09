import { plural } from '@examguard/contracts';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_TTL_MS = 90_000;

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export const COLOURS = ['red', 'green', 'blue'] as const;
export type Colour = (typeof COLOURS)[number];
export const TURN_DIRECTIONS = ['left', 'right'] as const;
export type TurnDirection = (typeof TURN_DIRECTIONS)[number];

export const CHALLENGE_TYPES = ['colour_flash', 'head_turn', 'spoken_words'] as const;
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];

/**
 * Since migration 0007 challenge_type holds the real kind. Rows written earlier
 * hold flash/gesture/word and carry the real kind in challenge_data.kind, so
 * this deliberately returns undefined for those legacy names.
 */
export function kindFromStoredType(stored: string): ChallengeType | undefined {
  return (CHALLENGE_TYPES as readonly string[]).includes(stored)
    ? (stored as ChallengeType)
    : undefined;
}

/**
 * The colour reflection is the method. Spoken words is the only alternative (accessibility, in
 * pre-exam setup). Head turn is no longer issued; its verifier stays for already-stored rows.
 */
export function selectChallengeType(preferred?: unknown): ChallengeType {
  return preferred === 'spoken_words' ? preferred : 'colour_flash';
}

export const SPOKEN_WORD_POOL = [
  'apple',
  'river',
  'table',
  'green',
  'window',
  'orange',
  'garden',
  'music',
  'bridge',
  'candle',
  'mountain',
  'yellow',
  'paper',
  'pencil',
  'school',
  'summer',
  'island',
  'cloud',
  'basket',
  'forest',
  'silver',
  'planet',
  'ladder',
  'butter',
  'rabbit',
  'pillow',
  'market',
  'ocean',
  'bottle',
  'chair',
] as const;

function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)]!;
}

export interface GeneratedChallenge {
  readonly nonce: string;
  readonly type: ChallengeType;
  /** Includes `kind` and the random sequence/words; covered by the signature. */
  readonly data: Record<string, unknown>;
  readonly expiresAt: string;
  /** HMAC over attempt, nonce, type, expiry and data; the client must echo it back. */
  readonly signature?: string;
}

/**
 * `pulse`: the mid-exam spot check. The same signed random colour sequence, shown as a subtle,
 * low-intensity screen-edge pulse instead of a full-screen flash; scored with PULSE_THRESHOLDS.
 */
export function generateChallenge(
  type: ChallengeType,
  options: { readonly pulse?: boolean } = {},
): GeneratedChallenge {
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  let data: Record<string, unknown>;

  if (type === 'colour_flash') {
    // No colour twice in a row, so consecutive flashes are distinguishable.
    const sequence: Colour[] = [];
    while (sequence.length < 3) {
      const next = pick(COLOURS);
      if (next !== sequence[sequence.length - 1]) sequence.push(next);
    }
    data =
      options.pulse === true ? { kind: type, sequence, mode: 'pulse' } : { kind: type, sequence };
  } else if (type === 'head_turn') {
    data = { kind: type, sequence: [pick(TURN_DIRECTIONS), pick(TURN_DIRECTIONS)] };
  } else {
    const words = new Set<string>();
    while (words.size < 3) words.add(pick(SPOKEN_WORD_POOL));
    data = { kind: type, words: [...words] };
  }

  return { nonce, type, data, expiresAt };
}

export interface VerifyResult {
  readonly passed: boolean;
  readonly detail: string;
}

// ── Colour flash ──────────────────────────────────────────────────────────────

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The flashed channel's ratio must beat both other channels' by this much. */
export const COLOUR_MARGIN = 0.02;
/** Minimum ratio rise of the flashed channel for one flash to count. */
export const COLOUR_MIN_RISE = 0.03;
/** Mean flashed-channel rise across all flashes (the "small overall rise"). */
export const COLOUR_OVERALL_RISE = 0.04;

export interface ColourThresholds {
  readonly margin: number;
  readonly minRise: number;
  readonly overallRise: number;
}
export const FLASH_THRESHOLDS: ColourThresholds = {
  margin: COLOUR_MARGIN,
  minRise: COLOUR_MIN_RISE,
  overallRise: COLOUR_OVERALL_RISE,
};
/**
 * The mid-exam edge pulse is deliberately dim (photosensitivity), so its reflection is smaller.
 * The same per-channel ratio rule applies; only the minimum rises are lower. A miss is retried
 * and never treated as a finding on its own.
 */
export const PULSE_THRESHOLDS: ColourThresholds = {
  margin: 0.006,
  minRise: 0.01,
  overallRise: 0.012,
};
export const COLOUR_REQUIRED_FLASHES = 2;
/** Floor for baseline channel values so near-black frames do not explode ratios. */
const BASELINE_FLOOR = 10;

const COLOUR_RETRY_HINT = 'If it keeps failing, use the spoken-words check.';
export const NO_FACE_DETAIL =
  "We couldn't see your face — sit facing the camera and try again. " + COLOUR_RETRY_HINT;

function validRgb(value: unknown): value is Rgb {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return [v.r, v.g, v.b].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 255,
  );
}

/**
 * Scores the client's mean-RGB readings of the face region. Each frame is
 * compared with the baseline as a per-channel ratio, so the rule is the same
 * for dark and light skin and for dim and bright rooms: the flashed colour's
 * channel must rise more than the other two. `faces` says, per flash, whether
 * the on-device face detector saw a face; a pass needs one in at least 2 of 3
 * flashes, and only those flashes can count as a hit. Without it a blank or
 * looping feed that happens to shift colour would pass.
 */
export function scoreColourResponse(
  sequence: readonly Colour[],
  baseline: unknown,
  frames: unknown,
  faces?: unknown,
  thresholds: ColourThresholds = FLASH_THRESHOLDS,
): VerifyResult {
  if (!validRgb(baseline) || !Array.isArray(frames) || frames.length !== sequence.length) {
    return { passed: false, detail: `Colour readings were incomplete. ${COLOUR_RETRY_HINT}` };
  }
  if (!frames.every(validRgb)) {
    return { passed: false, detail: `Colour readings were invalid. ${COLOUR_RETRY_HINT}` };
  }
  const faceSeen =
    Array.isArray(faces) && faces.length === sequence.length
      ? faces.map((face) => face === true)
      : sequence.map(() => false);
  if (faceSeen.filter(Boolean).length < COLOUR_REQUIRED_FLASHES) {
    return { passed: false, detail: NO_FACE_DETAIL };
  }
  const channel: Record<Colour, 'r' | 'g' | 'b'> = { red: 'r', green: 'g', blue: 'b' };
  let hits = 0;
  let riseTotal = 0;
  sequence.forEach((colour, index) => {
    const frame = frames[index] as Rgb;
    const ratio = (key: 'r' | 'g' | 'b') => frame[key] / Math.max(baseline[key], BASELINE_FLOOR);
    const own = channel[colour];
    const flashed = ratio(own);
    const others = (['r', 'g', 'b'] as const).filter((key) => key !== own).map(ratio);
    riseTotal += flashed - 1;
    if (
      faceSeen[index] &&
      flashed - 1 >= thresholds.minRise &&
      others.every((o) => flashed - o >= thresholds.margin)
    ) {
      hits += 1;
    }
  });
  const overall = riseTotal / sequence.length;
  const passed = hits >= COLOUR_REQUIRED_FLASHES && overall >= thresholds.overallRise;
  return {
    passed,
    detail: passed
      ? `Check passed (client-measured): screen colours matched on ${hits} of ${plural(sequence.length, 'flash', 'flashes')}`
      : `Only ${hits} of ${plural(sequence.length, 'colour flash', 'colour flashes')} ${hits === 1 ? 'was' : 'were'} reflected on your face. ` +
        `Face the screen in a dimmer spot and retry. ${COLOUR_RETRY_HINT}`,
  };
}

// ── Head turn ─────────────────────────────────────────────────────────────────

export interface YawSample {
  readonly t: number;
  /** Degrees relative to the student's starting pose; positive is their right. */
  readonly yaw: number;
}

export const TURN_THRESHOLD_DEG = 15;
/** The head must come back inside this angle between turns. */
export const TURN_CENTRE_DEG = 8;
export const TURN_MIN_SPAN_MS = 1000;
const MAX_YAW_SAMPLES = 1500;

function parseYawSamples(samples: unknown): YawSample[] | null {
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_YAW_SAMPLES) {
    return null;
  }
  const parsed: YawSample[] = [];
  for (const sample of samples) {
    const v = sample as { t?: unknown; yaw?: unknown } | null;
    if (typeof v?.t !== 'number' || typeof v.yaw !== 'number') return null;
    if (!Number.isFinite(v.t) || !Number.isFinite(v.yaw) || Math.abs(v.yaw) > 180) return null;
    if (parsed.length > 0 && v.t < parsed[parsed.length - 1]!.t) return null;
    parsed.push({ t: v.t, yaw: v.yaw });
  }
  return parsed;
}

/** Verifies the requested turns happened in order, re-centring between them. */
export function verifyHeadTurns(
  sequence: readonly TurnDirection[],
  samples: unknown,
): VerifyResult {
  const parsed = parseYawSamples(samples);
  if (!parsed) return { passed: false, detail: 'Head-turn readings were missing or invalid' };
  if (parsed[parsed.length - 1]!.t - parsed[0]!.t < TURN_MIN_SPAN_MS) {
    return { passed: false, detail: 'Head-turn recording was too short' };
  }
  let done = 0;
  let needCentre = false;
  for (const { yaw } of parsed) {
    if (done === sequence.length) break;
    if (needCentre) {
      if (Math.abs(yaw) <= TURN_CENTRE_DEG) needCentre = false;
      continue;
    }
    const sign = sequence[done] === 'right' ? 1 : -1;
    if (sign * yaw >= TURN_THRESHOLD_DEG) {
      done += 1;
      needCentre = true;
    }
  }
  const passed = done === sequence.length;
  return {
    passed,
    detail: passed
      ? `Check passed (client-measured): head turned ${sequence.join(' then ')} as requested`
      : `Completed ${done} of ${sequence.length} requested head turns (${sequence.join(' then ')})`,
  };
}

// ── Spoken words ──────────────────────────────────────────────────────────────

export const SPOKEN_WORDS_REQUIRED = 2;

export function normaliseSpeech(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function verifySpokenWords(words: readonly string[], transcript: string): VerifyResult {
  const heard = new Set(normaliseSpeech(transcript));
  const matched = words.filter((word) => heard.has(word.toLowerCase())).length;
  const passed = matched >= SPOKEN_WORDS_REQUIRED;
  return {
    passed,
    detail: passed
      ? `Heard ${matched} of ${plural(words.length, 'word')} — live person confirmed`
      : `Heard ${matched} of ${plural(words.length, 'word')}; at least ${SPOKEN_WORDS_REQUIRED} are needed`,
  };
}

interface SignedFields {
  readonly attemptId: string;
  readonly nonce: string;
  readonly type: string;
  readonly expiresAt: string;
  /** Challenge data (sequence/words); signed so the client cannot choose its own. */
  readonly data?: Record<string, unknown> | string;
}

/**
 * HMAC-SHA256 over the challenge's identity and data, so a client cannot forge
 * a challenge, swap its type or sequence, extend its expiry or replay it on
 * another attempt.
 */
export function signNonce(fields: SignedFields, secret: string): string {
  return createHmac('sha256', secret)
    .update(
      [
        fields.attemptId,
        fields.nonce,
        fields.type,
        fields.expiresAt,
        typeof fields.data === 'string' ? fields.data : JSON.stringify(fields.data ?? {}),
      ].join('\n'),
    )
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
