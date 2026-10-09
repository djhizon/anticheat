import type { Box } from './gazeEstimator.js';

/**
 * Temporal confirmation for the browser phone detector. The detector reports candidates at a low
 * score (>= CANDIDATE_SCORE); a phone is only "confirmed" when the evidence is consistent:
 *   - at least CONFIRM_HITS of the last WINDOW fresh detector frames scored >= CONFIRM_SCORE, or
 *   - any frame in that window scored >= STRONG_SCORE.
 * Boxes overlapping the face are reported (overlapsFace) but never discarded: a phone held to the
 * ear legitimately overlaps the face, so suppressing them would hide real positives.
 */
export const CANDIDATE_SCORE = 0.4;
export const CONFIRM_SCORE = 0.5;
export const STRONG_SCORE = 0.75;
export const WINDOW = 5;
export const CONFIRM_HITS = 3;
/** Fresh samples older than this no longer count (detector runs about once a second). */
export const MAX_AGE_MS = 10_000;

export type PhoneState = 'none' | 'candidate' | 'confirmed';

export interface PhoneReading {
  /** Best "cell phone" score in this frame, or null when nothing was above the candidate floor. */
  readonly score: number | null;
  /** False when the detector did not run for this frame (cached result): ignored. */
  readonly fresh: boolean;
  readonly now: number;
  readonly box?: Box | null;
  readonly faceBox?: Box | null;
}

export interface PhoneEvidence {
  readonly state: PhoneState;
  /** Highest score currently inside the window (0 when none). */
  readonly best: number;
  readonly lastScore: number | null;
  readonly maxScore: number;
  /** Fresh detector frames at or above the candidate floor, since the session began. */
  readonly candidateFrames: number;
  /** Rising edges into the confirmed state. */
  readonly confirmations: number;
  readonly box: Box | null;
  readonly overlapsFace: boolean;
  readonly windowHits: number;
}

/** Fraction of box `a` that lies inside box `b` (0..1). */
export function overlapFraction(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || a.w * a.h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

export function createPhoneEvidence() {
  let window: Array<{ score: number; at: number }> = [];
  let lastScore: number | null = null;
  let maxScore = 0;
  let candidateFrames = 0;
  let confirmations = 0;
  let wasConfirmed = false;
  let box: Box | null = null;
  let overlapsFace = false;

  function evaluate(now: number): PhoneEvidence {
    window = window.filter((s) => now - s.at <= MAX_AGE_MS).slice(-WINDOW);
    const hits = window.filter((s) => s.score >= CONFIRM_SCORE).length;
    const best = window.reduce((m, s) => Math.max(m, s.score), 0);
    const confirmed = hits >= CONFIRM_HITS || best >= STRONG_SCORE;
    const state: PhoneState = confirmed
      ? 'confirmed'
      : best >= CANDIDATE_SCORE
        ? 'candidate'
        : 'none';
    if (confirmed && !wasConfirmed) confirmations += 1;
    wasConfirmed = confirmed;
    return {
      state,
      best,
      lastScore,
      maxScore,
      candidateFrames,
      confirmations,
      box: state === 'none' ? null : box,
      overlapsFace: state === 'none' ? false : overlapsFace,
      windowHits: hits,
    };
  }

  return {
    sample(reading: PhoneReading): PhoneEvidence {
      if (reading.fresh) {
        const score = reading.score ?? 0;
        window.push({ score, at: reading.now });
        if (reading.score !== null && reading.score >= CANDIDATE_SCORE) {
          candidateFrames += 1;
          lastScore = reading.score;
          maxScore = Math.max(maxScore, reading.score);
          box = reading.box ?? null;
          overlapsFace =
            reading.box != null &&
            reading.faceBox != null &&
            overlapFraction(reading.box, reading.faceBox) > 0.6;
        }
      }
      return evaluate(reading.now);
    },
    /** Drop the temporal window (stale vision); lifetime counters are kept. */
    clear(): void {
      window = [];
      wasConfirmed = false;
      box = null;
      overlapsFace = false;
    },
  };
}
