import { SECTORS, type GazeSample } from './gazeEstimator.js';
import type { PhoneEvidence } from './phoneEvidence.js';

/**
 * Running on-device statistics over vision observations. Pure and clock-free: every time is a
 * monotonic millisecond value supplied by the caller. Nothing here leaves the device and none of
 * it is a verdict: looking away is normal (thinking, notes, scrap paper where allowed).
 */
export const MIN_LOOK_AWAY_MS = 1000;
/** On-screen readings must persist this long before a look-away is considered over. */
export const RETURN_GRACE_MS = 600;
/** A gap longer than this between observations is not attributed to any state. */
export const MAX_GAP_MS = 2000;
export const BLINK_ON = 0.5;
export const BLINK_OFF = 0.3;
const BLINK_WINDOW_MS = 60_000;
const MIN_BLINK_OBSERVED_MS = 10_000;

export interface StatsInput {
  readonly t: number;
  readonly faces: number;
  readonly gaze: GazeSample | null;
  readonly blink: number;
  /** 0..1 tracking-quality proxy. */
  readonly quality: number;
  readonly phone: PhoneEvidence | null;
  readonly phoneAvailable: boolean;
}

export interface GazeStatsSnapshot {
  readonly observedMs: number;
  readonly gazeMs: number;
  /** Share of gaze-tracked time that was on screen, or null before any gaze time. */
  readonly onScreenPct: number | null;
  readonly facePresentPct: number | null;
  readonly lookAwayCount: number;
  readonly longestLookAwayMs: number;
  readonly averageLookAwayMs: number;
  /** Length of the look-away in progress (0 when none, or not yet long enough to count). */
  readonly currentLookAwayMs: number;
  /** Off-screen time per compass sector, indexed like SECTORS. */
  readonly sectorMs: readonly number[];
  readonly onScreenMs: number;
  readonly blinkCount: number;
  /** Blinks per minute (rolling 60 s), null until 10 s have been observed. */
  readonly blinkRatePerMin: number | null;
  readonly multipleFaceEvents: number;
  readonly multipleFaceMs: number;
  readonly quality: number | null;
  readonly phoneAvailable: boolean;
  readonly phoneCandidateFrames: number;
  readonly phoneConfirmations: number;
  readonly phoneLastScore: number | null;
  readonly phoneMaxScore: number;
  readonly phoneState: 'none' | 'candidate' | 'confirmed';
  /** Observations per second of the vision worker (smoothed). */
  readonly fps: number | null;
}

export function createGazeStats() {
  let prev: StatsInput | null = null;
  let firstT: number | null = null;
  let observedMs = 0;
  let faceMs = 0;
  let gazeMs = 0;
  let onScreenMs = 0;
  const sectorMs: number[] = SECTORS.map(() => 0);
  let multipleFaceMs = 0;
  let multipleFaceEvents = 0;
  let blinkOpen = true;
  const blinkTimes: number[] = [];
  let blinkCount = 0;
  let quality: number | null = null;
  let fps: number | null = null;
  let phoneAvailable = false;
  let phoneEvidence: PhoneEvidence | null = null;

  // Look-away episode.
  let episodeStart: number | null = null;
  let episodeLastOff = 0;
  let episodeCounted = false;
  let onSince: number | null = null;
  let lookAwayCount = 0;
  let completedTotal = 0;
  let completedCount = 0;
  let longest = 0;
  let current = 0;

  function closeEpisode(end: number): void {
    if (episodeStart !== null && episodeCounted) {
      const d = Math.max(0, end - episodeStart);
      completedTotal += d;
      completedCount += 1;
      longest = Math.max(longest, d);
    }
    episodeStart = null;
    episodeCounted = false;
    onSince = null;
    current = 0;
  }

  return {
    add(input: StatsInput): void {
      firstT ??= input.t;
      if (prev !== null) {
        const gap = input.t - prev.t;
        if (gap > 0 && gap <= MAX_GAP_MS) {
          observedMs += gap;
          if (prev.faces >= 1) faceMs += gap;
          if (prev.faces >= 2) multipleFaceMs += gap;
          if (prev.gaze !== null) {
            gazeMs += gap;
            if (prev.gaze.onScreen) onScreenMs += gap;
            else sectorMs[SECTORS.indexOf(prev.gaze.sector)]! += gap;
          }
        }
        if (gap > 0 && gap < 5000) {
          const rate = 1000 / gap;
          fps = fps === null ? rate : fps * 0.7 + rate * 0.3;
        }
        if (gap > MAX_GAP_MS && episodeStart !== null) closeEpisode(episodeLastOff);
      }
      if (input.faces >= 2 && (prev === null || prev.faces < 2)) multipleFaceEvents += 1;

      // Blink edges (hysteresis).
      if (input.faces === 1) {
        if (blinkOpen && input.blink > BLINK_ON) {
          blinkOpen = false;
          blinkCount += 1;
          blinkTimes.push(input.t);
        } else if (!blinkOpen && input.blink < BLINK_OFF) blinkOpen = true;
      }
      while (blinkTimes.length > 0 && input.t - blinkTimes[0]! > BLINK_WINDOW_MS)
        blinkTimes.shift();

      // Look-away episodes only count real, tracked gaze (a missing face is a separate stat).
      if (input.gaze !== null && !input.gaze.onScreen) {
        if (episodeStart === null) {
          episodeStart = input.t;
          episodeCounted = false;
        }
        onSince = null;
        episodeLastOff = input.t;
        if (!episodeCounted && input.t - episodeStart >= MIN_LOOK_AWAY_MS) {
          episodeCounted = true;
          lookAwayCount += 1;
        }
        current = episodeCounted ? input.t - episodeStart : 0;
      } else if (input.gaze !== null) {
        if (episodeStart !== null) {
          onSince ??= input.t;
          if (input.t - onSince >= RETURN_GRACE_MS) closeEpisode(onSince);
        }
      } else if (episodeStart !== null) closeEpisode(episodeLastOff);

      if (input.gaze !== null || input.faces > 0) quality = input.quality;
      else quality = null;
      phoneAvailable = input.phoneAvailable;
      if (input.phone !== null) phoneEvidence = input.phone;
      prev = input;
    },
    snapshot(): GazeStatsSnapshot {
      const lastT = prev?.t ?? 0;
      const ongoing = episodeStart !== null && episodeCounted ? lastT - episodeStart : 0;
      const total = completedTotal + ongoing;
      const count = completedCount + (ongoing > 0 ? 1 : 0);
      const observed = firstT === null ? 0 : observedMs;
      const blinkWindow = Math.min(BLINK_WINDOW_MS, observed);
      return {
        observedMs: observed,
        gazeMs,
        onScreenPct: gazeMs > 0 ? (onScreenMs / gazeMs) * 100 : null,
        facePresentPct: observed > 0 ? (faceMs / observed) * 100 : null,
        lookAwayCount,
        longestLookAwayMs: Math.max(longest, ongoing),
        averageLookAwayMs: count > 0 ? total / count : 0,
        currentLookAwayMs: current,
        sectorMs: [...sectorMs],
        onScreenMs,
        blinkCount,
        blinkRatePerMin:
          observed >= MIN_BLINK_OBSERVED_MS ? (blinkTimes.length / blinkWindow) * 60_000 : null,
        multipleFaceEvents,
        multipleFaceMs,
        quality,
        phoneAvailable,
        phoneCandidateFrames: phoneEvidence?.candidateFrames ?? 0,
        phoneConfirmations: phoneEvidence?.confirmations ?? 0,
        phoneLastScore: phoneEvidence?.lastScore ?? null,
        phoneMaxScore: phoneEvidence?.maxScore ?? 0,
        phoneState: phoneEvidence?.state ?? 'none',
        fps,
      };
    },
    reset(): void {
      prev = null;
      firstT = null;
      observedMs = faceMs = gazeMs = onScreenMs = multipleFaceMs = 0;
      sectorMs.fill(0);
      multipleFaceEvents = blinkCount = 0;
      blinkOpen = true;
      blinkTimes.length = 0;
      quality = null;
      fps = null;
      phoneEvidence = null;
      episodeStart = null;
      episodeCounted = false;
      onSince = null;
      lookAwayCount = completedTotal = completedCount = longest = current = 0;
    },
  };
}
