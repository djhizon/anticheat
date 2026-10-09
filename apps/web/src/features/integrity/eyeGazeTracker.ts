import {
  applyCalibration,
  buildSample,
  createBlendSignLearner,
  createOneEuro,
  eyeOffsetDegrees,
  rawGaze,
  type Angles,
  type GazeCalibration,
  type GazeSample,
  type RawGaze,
} from './gazeEstimator.js';
import { createGazeStats, type GazeStatsSnapshot } from './gazeStats.js';
import {
  createImplicitCalibrator,
  median,
  type AutoCalibrationState,
  type ScreenPoint,
  type ScreenSize,
} from './implicitCalibration.js';
import type { VisionSample } from './visionSignals.js';

const TRAIL_MS = 5000;
/** A blink hides the eyes for a moment; the last eye offset is held this long. */
const EYE_HOLD_MS = 600;
const MAX_GAP_MS = 2000;
const RECENT_RAW_MS = 2500;
/** Raw gaze this long before an interaction is taken as "looking at the target". */
const PAIR_LOOKBACK_MS = 600;
/** Fallback: the latest raw reading if it is at most this old. */
const PAIR_FALLBACK_MS = 1000;
const MIN_POINTER_PAIR_GAP_MS = 400;
const MIN_TYPING_PAIR_GAP_MS = 3000;
/** Keystrokes keep the "typing" state alive this long. */
const TYPING_ACTIVE_MS = 1500;

/** One student interaction that implies where they were looking. */
export interface InteractionEvent {
  /** pointer = click/tap at the pointer position; focus = answer field focused; typing = keystroke. */
  readonly kind: 'pointer' | 'focus' | 'typing';
  /** Monotonic milliseconds (performance.now), same clock as vision samples. */
  readonly t: number;
  readonly point: ScreenPoint;
  /** False when the point is only roughly known (e.g. typing in a large text area). */
  readonly precise: boolean;
}

export interface EyeGazeSnapshot {
  readonly sample: GazeSample | null;
  /** Samples from the last ~5 s, oldest first. */
  readonly trail: readonly GazeSample[];
  readonly stats: GazeStatsSnapshot;
  readonly calibration: GazeCalibration;
  readonly auto: AutoCalibrationState;
}

export interface EyeGazeTracker {
  /** Feed one vision observation. Returns the gaze sample, or null when there is no single face. */
  push(sample: VisionSample): GazeSample | null;
  /** Feed one click/focus/keystroke (implicit calibration). Never blocks or throws. */
  observeInteraction(event: InteractionEvent): void;
  latest(): GazeSample | null;
  snapshot(): EyeGazeSnapshot;
  getCalibration(): GazeCalibration;
  calibrationState(): AutoCalibrationState;
  /** Forget the learned calibration (keeps statistics). */
  resetCalibration(): void;
  /** Forget everything (new attempt / camera restarted). */
  reset(): void;
}

/**
 * Detects when the eyes cannot be trusted (glasses glare, low light): iris readings missing
 * most of the time, jumping frame to frame, or poor tracking quality. Hysteresis avoids
 * flapping between eye and head-only modes.
 */
export function createEyeReliability(window = 10) {
  let reliable = true;
  let frames: Array<{ h: number | null; quality: number }> = [];
  return {
    push(h: number | null, quality: number): boolean {
      frames.push({ h, quality });
      if (frames.length > window) frames.shift();
      if (frames.length < 4) return reliable;
      const missing = frames.filter((f) => f.h === null).length / frames.length;
      const diffs: number[] = [];
      for (let i = 1; i < frames.length; i += 1) {
        const a = frames[i - 1]!.h;
        const b = frames[i]!.h;
        if (a !== null && b !== null) diffs.push(Math.abs(b - a));
      }
      const jitter = diffs.length >= 3 ? median(diffs) : 0;
      const q = median(frames.map((f) => f.quality));
      if (reliable) reliable = !(missing > 0.6 || jitter > 0.15 || q < 0.4);
      else reliable = missing < 0.4 && jitter < 0.1 && q >= 0.5;
      return reliable;
    },
    reliable: () => reliable,
    reset(): void {
      reliable = true;
      frames = [];
    },
  };
}

function defaultScreen(): ScreenSize | undefined {
  if (typeof window === 'undefined' || !window.screen) return undefined;
  const { width, height } = window.screen;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Combines the estimator, implicit calibration, smoothing and statistics for one camera
 * session. `onSample` is the hook for the integrity log: it receives every smoothed, calibrated
 * sample (about 2 to 4 per second), so consumers should debounce.
 */
export function createEyeGazeTracker(
  options: {
    readonly onSample?: (sample: GazeSample) => void;
    readonly screen?: ScreenSize;
  } = {},
): EyeGazeTracker {
  const screen = options.screen ?? defaultScreen();
  const calibrator = createImplicitCalibrator(screen ? { screen } : {});
  const reliability = createEyeReliability();
  const stats = createGazeStats();
  const yawFilter = createOneEuro();
  const pitchFilter = createOneEuro();
  const learner = createBlendSignLearner();
  let calibration: GazeCalibration = calibrator.calibration(false);
  let trail: GazeSample[] = [];
  let latest: GazeSample | null = null;
  let lastEye: { angles: Angles; t: number } | null = null;
  let lastT = -Infinity;
  let recentRaw: Array<{ raw: RawGaze; t: number }> = [];
  let typing: { t: number; point: ScreenPoint } | null = null;
  let lastPointerPair = -Infinity;
  let lastTypingPair = -Infinity;
  let headOnly = false;

  function lose(): void {
    yawFilter.reset();
    pitchFilter.reset();
    lastEye = null;
    latest = null;
  }

  const combined = (r: RawGaze): Angles => ({
    yaw: r.headYaw + r.eyeYaw,
    pitch: r.headPitch + r.eyePitch,
  });
  const headOf = (r: RawGaze): Angles => ({ yaw: r.headYaw, pitch: r.headPitch });

  function addPair(t: number, point: ScreenPoint): void {
    let window = recentRaw.filter((r) => r.t <= t + 50 && t - r.t <= PAIR_LOOKBACK_MS);
    if (window.length === 0) {
      const last = recentRaw[recentRaw.length - 1];
      if (last === undefined || t - last.t > PAIR_FALLBACK_MS || last.t - t > 50) return;
      window = [last];
    }
    const eyes = window.filter((r) => r.raw.eyesValid).map((r) => combined(r.raw));
    const heads = window.map((r) => headOf(r.raw));
    calibrator.addPair({
      t,
      target: point,
      eyes:
        eyes.length > 0
          ? { yaw: median(eyes.map((e) => e.yaw)), pitch: median(eyes.map((e) => e.pitch)) }
          : null,
      head: { yaw: median(heads.map((h) => h.yaw)), pitch: median(heads.map((h) => h.pitch)) },
    });
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
        const eyeFeatures = observation.eye ?? null;
        learner.add(eyeFeatures?.irisH ?? null, eyeFeatures?.blendH ?? null);
        const fresh = eyeOffsetDegrees(eyeFeatures, learner.sign());
        let eye = fresh;
        if (fresh !== null) lastEye = { angles: fresh, t: at };
        else if (lastEye !== null && at - lastEye.t <= EYE_HOLD_MS) eye = lastEye.angles;
        headOnly = !reliability.push(
          fresh === null ? null : (eyeFeatures?.irisH ?? eyeFeatures?.blendH ?? null),
          observation.quality ?? 0,
        );
        calibrator.observeFace({
          t: at,
          box: observation.faceBox,
          ipd: eyeFeatures?.ipd ?? null,
          headYaw: observation.pose.yaw,
          headPitch: observation.pose.pitch,
        });
        const raw = rawGaze(observation.pose, observation.headRoll ?? null, eye);
        const measured: RawGaze = { ...raw, eyesValid: fresh !== null };
        recentRaw.push({ raw: measured, t: at });
        recentRaw = recentRaw.filter((r) => at - r.t <= RECENT_RAW_MS);
        if (typing !== null && at - typing.t <= TYPING_ACTIVE_MS) {
          calibrator.observeTyping({
            t: at,
            target: typing.point,
            eyes: measured.eyesValid ? combined(measured) : null,
            head: headOf(measured),
          });
        }
        calibration = calibrator.calibration(headOnly);
        const input = headOnly ? { ...raw, eyeYaw: 0, eyePitch: 0 } : raw;
        const angles = applyCalibration(input, calibration);
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
    observeInteraction(event) {
      const { x, y } = event.point;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(event.t)) return;
      if (event.kind === 'typing') typing = { t: event.t, point: event.point };
      if (!event.precise) return;
      if (event.kind === 'typing') {
        if (event.t - lastTypingPair < MIN_TYPING_PAIR_GAP_MS) return;
        lastTypingPair = event.t;
      } else {
        // A focus right after a click on the same field is the same look.
        if (event.t - lastPointerPair < MIN_POINTER_PAIR_GAP_MS) return;
        lastPointerPair = event.t;
      }
      addPair(event.t, event.point);
    },
    latest: () => latest,
    snapshot: () => ({
      sample: latest,
      trail,
      stats: stats.snapshot(),
      calibration,
      auto: calibrator.state(headOnly),
    }),
    getCalibration: () => calibration,
    calibrationState: () => calibrator.state(headOnly),
    resetCalibration() {
      calibrator.reset();
      reliability.reset();
      headOnly = false;
      calibration = calibrator.calibration(false);
      typing = null;
      lastPointerPair = lastTypingPair = -Infinity;
    },
    reset() {
      stats.reset();
      lose();
      this.resetCalibration();
      learner.reset();
      trail = [];
      recentRaw = [];
      lastT = -Infinity;
    },
  };
}
