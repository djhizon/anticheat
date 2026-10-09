import {
  NO_CALIBRATION,
  applyCalibration,
  buildSample,
  createBlendSignLearner,
  createOneEuro,
  eyeOffsetDegrees,
  fitCalibration,
  rawGaze,
  type Angles,
  type CalibrationFit,
  type CalibrationTarget,
  type GazeCalibration,
  type GazeSample,
  type RawGaze,
} from './gazeEstimator.js';
import { createGazeStats, type GazeStatsSnapshot } from './gazeStats.js';
import type { VisionSample } from './visionSignals.js';

const TRAIL_MS = 5000;
/** A blink hides the eyes for a moment; the last eye offset is held this long. */
const EYE_HOLD_MS = 600;
const MAX_GAP_MS = 2000;
const RECENT_RAW_MS = 2500;

export interface EyeGazeSnapshot {
  readonly sample: GazeSample | null;
  /** Samples from the last ~5 s, oldest first. */
  readonly trail: readonly GazeSample[];
  readonly stats: GazeStatsSnapshot;
  readonly calibration: GazeCalibration;
}

export interface EyeGazeTracker {
  /** Feed one vision observation. Returns the gaze sample, or null when there is no single face. */
  push(sample: VisionSample): GazeSample | null;
  latest(): GazeSample | null;
  snapshot(): EyeGazeSnapshot;
  getCalibration(): GazeCalibration;
  setCalibration(calibration: GazeCalibration): void;
  /** Start/finish collecting raw readings for one calibration target. */
  beginCapture(): void;
  endCapture(): RawGaze[];
  /** Fit from collected targets and apply when successful. */
  applyFit(samples: Partial<Record<CalibrationTarget, readonly RawGaze[]>>): CalibrationFit | null;
  /** Centre-only fallback from the last couple of seconds of readings. */
  calibrateCentreNow(): CalibrationFit | null;
  clearCalibration(): void;
  /** Forget everything (new attempt / camera restarted). */
  reset(): void;
}

/**
 * Combines the estimator, calibration, smoothing and statistics for one camera session.
 * `onSample` is the hook for the integrity log: it receives every smoothed, calibrated sample
 * (about 2 to 4 per second), so consumers should debounce.
 */
export function createEyeGazeTracker(
  options: { readonly onSample?: (sample: GazeSample) => void } = {},
): EyeGazeTracker {
  let calibration: GazeCalibration = NO_CALIBRATION;
  const stats = createGazeStats();
  const yawFilter = createOneEuro();
  const pitchFilter = createOneEuro();
  const learner = createBlendSignLearner();
  let trail: GazeSample[] = [];
  let latest: GazeSample | null = null;
  let lastEye: { angles: Angles; t: number } | null = null;
  let lastT = -Infinity;
  let capture: RawGaze[] | null = null;
  let recentRaw: Array<{ raw: RawGaze; t: number }> = [];

  function lose(): void {
    yawFilter.reset();
    pitchFilter.reset();
    lastEye = null;
    latest = null;
  }

  return {
    push({ observation, at, phoneEvidence }): GazeSample | null {
      if (at - lastT > MAX_GAP_MS) {
        yawFilter.reset();
        pitchFilter.reset();
      }
      lastT = at;
      let gaze: GazeSample | null = null;
      if (observation.faces === 1 && observation.pose !== null) {
        learner.add(observation.eye?.irisH ?? null, observation.eye?.blendH ?? null);
        const fresh = eyeOffsetDegrees(observation.eye ?? null, learner.sign());
        let eye = fresh;
        if (fresh !== null) lastEye = { angles: fresh, t: at };
        else if (lastEye !== null && at - lastEye.t <= EYE_HOLD_MS) eye = lastEye.angles;
        const raw = rawGaze(observation.pose, observation.headRoll ?? null, eye);
        const measured: RawGaze = { ...raw, eyesValid: fresh !== null };
        capture?.push(measured);
        recentRaw.push({ raw: measured, t: at });
        recentRaw = recentRaw.filter((r) => at - r.t <= RECENT_RAW_MS);
        const angles = applyCalibration(raw, calibration);
        const smooth = {
          yaw: yawFilter.filter(angles.yaw, at),
          pitch: pitchFilter.filter(angles.pitch, at),
        };
        gaze = buildSample(
          at,
          angles,
          smooth,
          calibration,
          fresh !== null,
          observation.quality ?? 0,
        );
        latest = gaze;
        trail.push(gaze);
        trail = trail.filter((s) => at - s.t <= TRAIL_MS);
        options.onSample?.(gaze);
      } else {
        lose();
        trail = trail.filter((s) => at - s.t <= TRAIL_MS);
      }
      stats.add({
        t: at,
        faces: observation.faces,
        gaze,
        blink: observation.blinkScore,
        quality: observation.quality ?? 0,
        phone: phoneEvidence,
        phoneAvailable: observation.phoneAvailable !== false,
      });
      return gaze;
    },
    latest: () => latest,
    snapshot: () => ({ sample: latest, trail, stats: stats.snapshot(), calibration }),
    getCalibration: () => calibration,
    setCalibration(next) {
      calibration = next;
      yawFilter.reset();
      pitchFilter.reset();
    },
    beginCapture() {
      capture = [];
    },
    endCapture() {
      const out = capture ?? [];
      capture = null;
      return out;
    },
    applyFit(samples) {
      const fit = fitCalibration(samples);
      if (fit !== null) this.setCalibration(fit.calibration);
      return fit;
    },
    calibrateCentreNow() {
      return this.applyFit({ centre: recentRaw.map((r) => r.raw) });
    },
    clearCalibration() {
      this.setCalibration(NO_CALIBRATION);
    },
    reset() {
      stats.reset();
      lose();
      trail = [];
      recentRaw = [];
      capture = null;
      lastT = -Infinity;
    },
  };
}
