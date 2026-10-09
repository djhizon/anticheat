/**
 * Implicit (self-) calibration for webcam gaze: plug-and-play, no calibration step for the
 * student. Pure and clock-free (callers pass monotonic milliseconds), so it is fully testable
 * with synthetic data.
 *
 * Three sources, from weakest to strongest:
 *  1. Bootstrapping prior: the camera-centre model (gaze 0,0 = looking into the lens) with
 *     conservative on-screen extents derived from the estimated viewing distance and screen
 *     size. While confidence is low the on-screen zone is wide, so nobody is flagged early.
 *  2. Interaction pairs: when the student clicks/taps, focuses an answer field or types into a
 *     small answer box they are very likely looking at that spot. Each interaction records
 *     (raw gaze at that moment, point in screen-normalised coordinates). A robust per-axis line
 *     raw = offset + slope * target is refitted over the last PAIR_WINDOW pairs (Theil-Sen start,
 *     Huber IRLS with hard rejection of gross outliers such as looking at the keyboard while
 *     clicking). The slope (gain) is only trusted with enough spread of targets; otherwise the
 *     fit is offset-only.
 *  3. Statistical self-centering: while typing, the running median of the residual against the
 *     current model is folded into a slowly adapting (long time-constant EMA) drift term. A
 *     posture change (face scale/position jump that persists while still facing the camera)
 *     clears the pairs and re-enters a short learning phase with a wide tolerance.
 *
 * Geometry assumptions (documented in docs/LOCAL_AI.md):
 *  - webcam horizontal field of view WEBCAM_HFOV_DEG (65°; typical laptop webcams are 60-70°);
 *  - adult inter-pupillary distance ADULT_IPD_MM (63 mm), face-mesh width FACE_WIDTH_MM (140 mm)
 *    as a fallback when the irises are not visible;
 *  - physical screen width = CSS width x MM_PER_CSS_PX (0.25 mm), clamped to 300-700 mm, which
 *    slightly over-estimates laptop screens (conservative: a wider zone);
 *  - the camera sits CAMERA_GAP_MM above the top edge of the screen.
 */
import type { Angles, Box, Extent, GazeCalibration } from './gazeEstimator.js';

export const WEBCAM_HFOV_DEG = 65;
export const ADULT_IPD_MM = 63;
export const FACE_WIDTH_MM = 140;
export const DEFAULT_DISTANCE_MM = 550;
const DISTANCE_RANGE_MM = [300, 1200] as const;
export const MM_PER_CSS_PX = 0.25;
const SCREEN_WIDTH_RANGE_MM = [300, 700] as const;
export const CAMERA_GAP_MM = 10;
const DEFAULT_SCREEN: ScreenSize = { width: 1440, height: 900 };

/** Calibrated zone margin (as before). */
export const CALIBRATED_MARGIN = 1.25;
/** The calibrated zone also widens by this many residual sigmas of the fit. */
const RESIDUAL_SIGMAS = 2;
/**
 * Learning-phase tolerance around the camera-centre model. Sideways it allows a 2x gain error
 * (eye-gain heuristics and head-pose bias are only roughly right); vertically the zone already
 * spans the whole screen below the camera, so 1.5x is enough.
 */
export const LEARNING_MARGIN: Extent = { yaw: 2, pitch: 1.5 };
/** Additive learning-phase slack (degrees) for an unknown head-pose/eye offset. */
export const LEARNING_SLACK: Extent = { yaw: 6, pitch: 3 };
/** Extra half-extent (degrees) in head-only mode: the eyes can roam this far unseen. */
export const HEAD_ONLY_SLACK: Extent = { yaw: 12, pitch: 8 };
/** Confidence needed for the "Calibrated" label. */
export const CALIBRATED_CONFIDENCE = 0.5;
/** Head-only mode never reports more than this (it cannot see the eyes). */
const HEAD_ONLY_MAX_CONFIDENCE = 0.4;

export const PAIR_WINDOW = 40;
/** Target spread (fraction of the screen half-width/height, standard deviation) for a gain fit. */
export const MIN_GAIN_SPREAD = 0.25;
export const MIN_GAIN_PAIRS = 8;
/** Allowed |raw degrees per target degree|; outside this the fit is implausible. */
const SLOPE_RANGE = [0.33, 2.5] as const;
const MIN_SIGMA_DEG = 1.5;
const HUBER_K = 1.345;
const REJECT_SIGMAS = 3;
/** Head moves only part of the way toward a target; used for the head-only offset model. */
const HEAD_SHARE = 0.3;

const TYPING_BUFFER = 30;
const MIN_TYPING_SAMPLES = 6;
const DRIFT_TAU_LEARNING_MS = 4_000;
const DRIFT_TAU_MS = 30_000;
/** Drift may move the centre at most this far from the pair fit (posture resets handle more). */
const DRIFT_LIMIT: Extent = { yaw: 12, pitch: 15 };

const POSTURE_SHORT = 6;
const POSTURE_BASELINE_TAU_MS = 20_000;
const POSTURE_SCALE_JUMP = 0.2;
const POSTURE_SHIFT_JUMP = 0.5;
/** A head turned this far is looking somewhere, not a new posture. */
const POSTURE_MAX_HEAD_DELTA = 25;
export const POSTURE_HOLD_MS = 2500;
const DISTANCE_TAU_MS = 5_000;

export interface ScreenSize {
  /** CSS pixels (window.screen.width/height). */
  readonly width: number;
  readonly height: number;
}
/** Screen-normalised point: x -1 (left edge) .. +1 (right edge), y -1 (bottom) .. +1 (top). */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---------------------------------------------------------------- geometry prior

/** Pinhole focal length in normalised image-width units for a horizontal field of view. */
export function focalNorm(hfovDeg = WEBCAM_HFOV_DEG): number {
  return 0.5 / Math.tan(rad(hfovDeg / 2));
}

/**
 * Viewing distance (mm) from the inter-pupillary distance in normalised image-x units
 * (corrected for head yaw foreshortening), or from the face-mesh width as a fallback.
 * Null when neither is usable.
 */
export function viewingDistanceMm(input: {
  readonly ipd?: number | null | undefined;
  readonly faceWidth?: number | null | undefined;
  readonly headYaw?: number | undefined;
  readonly hfovDeg?: number | undefined;
}): number | null {
  const f = focalNorm(input.hfovDeg);
  // The pupils lie roughly in one plane, so a turned head foreshortens their distance by
  // cos(yaw). The face outline is a 3-D silhouette and barely shrinks, so it is not corrected.
  const foreshorten = Math.max(0.5, Math.cos(rad(clamp(input.headYaw ?? 0, -60, 60))));
  let d: number | null = null;
  if (input.ipd != null && input.ipd > 0.005) d = (ADULT_IPD_MM * f) / (input.ipd / foreshorten);
  else if (input.faceWidth != null && input.faceWidth > 0.02)
    d = (FACE_WIDTH_MM * f) / input.faceWidth;
  return d === null || !Number.isFinite(d)
    ? null
    : clamp(d, DISTANCE_RANGE_MM[0], DISTANCE_RANGE_MM[1]);
}

export interface ScreenGeometry {
  readonly distanceMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Half-extents of the screen around its own centre, in degrees. */
  readonly extent: Extent;
  /**
   * Conservative camera-centred zone used before any calibration: the whole screen lies below
   * the camera, so the pitch half-extent covers the full screen height, and both axes get the
   * learning margins.
   */
  readonly learningZone: Extent;
}

export function screenGeometry(distanceMm: number, screen: ScreenSize = DEFAULT_SCREEN) {
  const cssW = screen.width > 0 ? screen.width : DEFAULT_SCREEN.width;
  const cssH = screen.height > 0 ? screen.height : DEFAULT_SCREEN.height;
  const widthMm = clamp(cssW * MM_PER_CSS_PX, SCREEN_WIDTH_RANGE_MM[0], SCREEN_WIDTH_RANGE_MM[1]);
  const heightMm = widthMm * clamp(cssH / cssW, 0.4, 1);
  const d = clamp(distanceMm, DISTANCE_RANGE_MM[0], DISTANCE_RANGE_MM[1]);
  const extent = { yaw: deg(Math.atan(widthMm / 2 / d)), pitch: deg(Math.atan(heightMm / 2 / d)) };
  const learningZone = {
    yaw: extent.yaw * LEARNING_MARGIN.yaw + LEARNING_SLACK.yaw,
    pitch:
      deg(Math.atan((heightMm + CAMERA_GAP_MM) / d)) * LEARNING_MARGIN.pitch + LEARNING_SLACK.pitch,
  };
  return { distanceMm: d, widthMm, heightMm, extent, learningZone } satisfies ScreenGeometry;
}

// ---------------------------------------------------------------- robust line fit

export interface LineFit {
  /** raw at the screen centre (degrees). */
  readonly offset: number;
  /** raw degrees per target degree (signed). */
  readonly slope: number;
  /** Robust residual scale (degrees). */
  readonly sigma: number;
  readonly inliers: number;
  readonly total: number;
  readonly gainFitted: boolean;
}

function theilSen(xs: readonly number[], ys: readonly number[], minDx: number): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i += 1)
    for (let j = i + 1; j < xs.length; j += 1) {
      const dx = xs[j]! - xs[i]!;
      if (Math.abs(dx) >= minDx) slopes.push((ys[j]! - ys[i]!) / dx);
    }
  return slopes.length >= 3 ? median(slopes) : null;
}

function clampSlope(b: number, sign: 1 | -1): number {
  const s = b === 0 ? sign : Math.sign(b);
  return s * clamp(Math.abs(b), SLOPE_RANGE[0], SLOPE_RANGE[1]);
}

function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

/**
 * Robust per-axis fit of raw = offset + slope * target. Starts from Theil-Sen (or the prior
 * slope when the targets do not spread enough), refines with Huber IRLS and rejects residuals
 * beyond REJECT_SIGMAS robust sigmas entirely (RANSAC-like consensus).
 */
export function robustLine(
  xs: readonly number[],
  ys: readonly number[],
  options: {
    readonly priorSlope: number;
    readonly minSpread: number;
    readonly minPairs?: number;
    /** Fix the slope (offset-only fit) regardless of spread. */
    readonly fixedSlope?: boolean;
  },
): LineFit | null {
  const n = xs.length;
  if (n === 0 || ys.length !== n) return null;
  const priorSign: 1 | -1 = options.priorSlope < 0 ? -1 : 1;
  let fitSlope =
    !options.fixedSlope &&
    n >= (options.minPairs ?? MIN_GAIN_PAIRS) &&
    std(xs) >= options.minSpread;
  let b = options.priorSlope;
  if (fitSlope) {
    const ts = theilSen(xs, ys, options.minSpread * 0.5);
    if (ts === null) fitSlope = false;
    else b = clampSlope(ts, priorSign);
  }
  let a = median(xs.map((x, i) => ys[i]! - b * x));
  let sigma = MIN_SIGMA_DEG;
  let weights: number[] = xs.map(() => 1);
  for (let iter = 0; iter < 12; iter += 1) {
    const r = xs.map((x, i) => ys[i]! - a - b * x);
    sigma = Math.max(MIN_SIGMA_DEG, 1.4826 * median(r.map(Math.abs)));
    weights = r.map((v) => {
      const abs = Math.abs(v);
      if (abs > REJECT_SIGMAS * sigma) return 0;
      return abs <= HUBER_K * sigma ? 1 : (HUBER_K * sigma) / abs;
    });
    const sw = weights.reduce((s, w) => s + w, 0);
    if (sw <= 0) break;
    if (fitSlope) {
      const mx = weights.reduce((s, w, i) => s + w * xs[i]!, 0) / sw;
      const my = weights.reduce((s, w, i) => s + w * ys[i]!, 0) / sw;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n; i += 1) {
        sxx += weights[i]! * (xs[i]! - mx) ** 2;
        sxy += weights[i]! * (xs[i]! - mx) * (ys[i]! - my);
      }
      if (sxx > 1e-9) b = clampSlope(sxy / sxx, Math.sign(b) < 0 ? -1 : 1);
      a = my - b * mx;
    } else {
      a = weights.reduce((s, w, i) => s + w * (ys[i]! - b * xs[i]!), 0) / sw;
    }
  }
  const inliers = xs.filter((x, i) => Math.abs(ys[i]! - a - b * x) <= REJECT_SIGMAS * sigma).length;
  // The final gain is only trusted when the inliers themselves still spread enough.
  const inlierXs = xs.filter((x, i) => weights[i]! > 0);
  const gainFitted = fitSlope && std(inlierXs) >= options.minSpread;
  return { offset: a, slope: b, sigma, inliers, total: n, gainFitted };
}

/** 0..1 confidence of one axis fit: enough consistent pairs, small residuals, fitted gain. */
export function axisConfidence(fit: LineFit | null): number {
  if (fit === null) return 0;
  const count = clamp((fit.inliers - 2) / 10, 0, 1);
  const residual = clamp((12 - fit.sigma) / 7, 0, 1);
  const consensus = clamp(fit.inliers / fit.total / 0.6, 0, 1);
  return count * residual * consensus * (fit.gainFitted ? 1 : 0.6);
}

// ---------------------------------------------------------------- calibrator

/** Raw combined gaze (head + eyes, or head only) in degrees. */
export type RawAngles = Angles;

export interface InteractionPair {
  readonly t: number;
  readonly target: ScreenPoint;
  /** Head + eyes; null when the eyes were not readable at that moment. */
  readonly eyes: RawAngles | null;
  readonly head: RawAngles;
}

export interface FaceObservation {
  readonly t: number;
  readonly box: Box | null | undefined;
  readonly ipd?: number | null | undefined;
  readonly headYaw: number;
  readonly headPitch: number;
}

export type CalibrationPhase = 'learning' | 'calibrated';
export interface AutoCalibrationState {
  readonly phase: CalibrationPhase;
  /** 0..1 */
  readonly confidence: number;
  readonly pairs: number;
  readonly headOnly: boolean;
  readonly distanceMm: number;
  readonly gainFitted: { readonly yaw: boolean; readonly pitch: boolean };
  /** How many times a posture change restarted learning. */
  readonly postureResets: number;
}

interface ModelFit {
  readonly yaw: LineFit | null;
  readonly pitch: LineFit | null;
}

interface Drift {
  yaw: number;
  pitch: number;
  buffer: Array<{ yaw: number; pitch: number }>;
  lastT: number | null;
}
const newDrift = (): Drift => ({ yaw: 0, pitch: 0, buffer: [], lastT: null });

export function createImplicitCalibrator(options: { readonly screen?: ScreenSize } = {}) {
  const screen = options.screen ?? DEFAULT_SCREEN;
  let distance = DEFAULT_DISTANCE_MM;
  let distanceT: number | null = null;
  let geometry = screenGeometry(distance, screen);
  let fitExtent = geometry.extent;
  let pairs: InteractionPair[] = [];
  let eyeFit: ModelFit = { yaw: null, pitch: null };
  let headFit: ModelFit = { yaw: null, pitch: null };
  let eyeDrift = newDrift();
  let headDrift = newDrift();
  /** Learned sign of the slope per axis (a camera property; survives posture resets). */
  const sign: { yaw: 1 | -1; pitch: 1 | -1 } = { yaw: 1, pitch: 1 };
  let postureResets = 0;

  // Posture tracking.
  let baseline: { cx: number; cy: number; w: number; yaw: number; pitch: number } | null = null;
  let baselineT = 0;
  let recentFaces: Array<{ cx: number; cy: number; w: number; yaw: number; pitch: number }> = [];
  let deviatingSince: number | null = null;

  function refit(): void {
    fitExtent = geometry.extent;
    const eyes = pairs.filter((p) => p.eyes !== null);
    const axis = (
      list: readonly InteractionPair[],
      pick: (p: InteractionPair) => number,
      key: 'yaw' | 'pitch',
      head: boolean,
    ): LineFit | null => {
      if (list.length === 0) return null;
      const extent = fitExtent[key];
      const xs = list.map((p) => (key === 'yaw' ? p.target.x : p.target.y) * extent);
      const ys = list.map(pick);
      return robustLine(xs, ys, {
        priorSlope: sign[key] * (head ? HEAD_SHARE : 1),
        minSpread: MIN_GAIN_SPREAD * extent,
        fixedSlope: head,
      });
    };
    eyeFit = {
      yaw: axis(eyes, (p) => p.eyes!.yaw, 'yaw', false),
      pitch: axis(eyes, (p) => p.eyes!.pitch, 'pitch', false),
    };
    headFit = {
      yaw: axis(pairs, (p) => p.head.yaw, 'yaw', true),
      pitch: axis(pairs, (p) => p.head.pitch, 'pitch', true),
    };
    for (const key of ['yaw', 'pitch'] as const) {
      const f = eyeFit[key];
      if (f?.gainFitted) sign[key] = f.slope < 0 ? -1 : 1;
    }
  }

  function model(fit: ModelFit, key: 'yaw' | 'pitch', head: boolean) {
    const f = fit[key];
    return {
      offset: f?.offset ?? 0,
      slope: f?.slope ?? sign[key] * (head ? HEAD_SHARE : 1),
    };
  }

  function confidenceOf(headOnly: boolean): number {
    if (headOnly)
      return Math.min(
        HEAD_ONLY_MAX_CONFIDENCE,
        Math.min(axisConfidence(headFit.yaw), axisConfidence(headFit.pitch)),
      );
    return Math.min(axisConfidence(eyeFit.yaw), axisConfidence(eyeFit.pitch));
  }

  function clearLearning(): void {
    pairs = [];
    eyeFit = { yaw: null, pitch: null };
    headFit = { yaw: null, pitch: null };
    eyeDrift = newDrift();
    headDrift = newDrift();
  }

  function updateDistance(obs: FaceObservation): void {
    const d = viewingDistanceMm({
      ipd: obs.ipd,
      faceWidth: obs.box?.w ?? null,
      headYaw: obs.headYaw,
    });
    if (d === null) return;
    if (distanceT === null) distance = d;
    else {
      const dt = clamp(obs.t - distanceT, 0, 2000);
      distance += (d - distance) * (1 - Math.exp(-dt / DISTANCE_TAU_MS));
    }
    distanceT = obs.t;
    geometry = screenGeometry(distance, screen);
    if (Math.abs(geometry.extent.yaw / fitExtent.yaw - 1) > 0.05 && pairs.length > 0) refit();
  }

  function stepDrift(
    drift: Drift,
    fit: ModelFit,
    raw: RawAngles,
    target: ScreenPoint,
    t: number,
    head: boolean,
    learning: boolean,
  ): void {
    const ext = geometry.extent;
    const y = model(fit, 'yaw', head);
    const p = model(fit, 'pitch', head);
    drift.buffer.push({
      yaw: raw.yaw - (y.offset + y.slope * target.x * ext.yaw),
      pitch: raw.pitch - (p.offset + p.slope * target.y * ext.pitch),
    });
    if (drift.buffer.length > TYPING_BUFFER) drift.buffer.shift();
    const dt = drift.lastT === null ? 0 : clamp(t - drift.lastT, 0, 1000);
    drift.lastT = t;
    if (drift.buffer.length < MIN_TYPING_SAMPLES || dt <= 0) return;
    const alpha = 1 - Math.exp(-dt / (learning ? DRIFT_TAU_LEARNING_MS : DRIFT_TAU_MS));
    const my = median(drift.buffer.map((r) => r.yaw));
    const mp = median(drift.buffer.map((r) => r.pitch));
    drift.yaw = clamp(drift.yaw + (my - drift.yaw) * alpha, -DRIFT_LIMIT.yaw, DRIFT_LIMIT.yaw);
    drift.pitch = clamp(
      drift.pitch + (mp - drift.pitch) * alpha,
      -DRIFT_LIMIT.pitch,
      DRIFT_LIMIT.pitch,
    );
  }

  return {
    /**
     * Feed every single-face observation: tracks viewing distance and posture. Returns true
     * when a posture change restarted the learning phase.
     */
    observeFace(obs: FaceObservation): boolean {
      updateDistance(obs);
      const box = obs.box;
      if (!box || !(box.w > 0)) return false;
      const face = {
        cx: box.x + box.w / 2,
        cy: box.y + box.h / 2,
        w: box.w,
        yaw: obs.headYaw,
        pitch: obs.headPitch,
      };
      recentFaces.push(face);
      if (recentFaces.length > POSTURE_SHORT) recentFaces.shift();
      if (baseline === null) {
        baseline = { ...face };
        baselineT = obs.t;
        return false;
      }
      const now = {
        cx: median(recentFaces.map((f) => f.cx)),
        cy: median(recentFaces.map((f) => f.cy)),
        w: median(recentFaces.map((f) => f.w)),
        yaw: median(recentFaces.map((f) => f.yaw)),
        pitch: median(recentFaces.map((f) => f.pitch)),
      };
      const scaleJump = Math.abs(now.w / baseline.w - 1) > POSTURE_SCALE_JUMP;
      const shiftJump =
        Math.hypot(now.cx - baseline.cx, now.cy - baseline.cy) > POSTURE_SHIFT_JUMP * baseline.w;
      const facingCamera =
        Math.abs(now.yaw - baseline.yaw) <= POSTURE_MAX_HEAD_DELTA &&
        Math.abs(now.pitch - baseline.pitch) <= POSTURE_MAX_HEAD_DELTA;
      if ((scaleJump || shiftJump) && facingCamera) {
        deviatingSince ??= obs.t;
        if (obs.t - deviatingSince >= POSTURE_HOLD_MS) {
          baseline = { ...now };
          baselineT = obs.t;
          deviatingSince = null;
          postureResets += 1;
          clearLearning();
          // Re-estimate the geometry for the new distance straight away.
          distanceT = null;
          updateDistance(obs);
          return true;
        }
        return false;
      }
      deviatingSince = null;
      const dt = clamp(obs.t - baselineT, 0, 2000);
      baselineT = obs.t;
      const k = 1 - Math.exp(-dt / POSTURE_BASELINE_TAU_MS);
      for (const key of ['cx', 'cy', 'w', 'yaw', 'pitch'] as const)
        baseline[key] += (now[key] - baseline[key]) * k;
      return false;
    },
    /** One interaction pair (click/tap, focus or typing in a small field). */
    addPair(pair: InteractionPair): void {
      pairs.push(pair);
      if (pairs.length > PAIR_WINDOW) pairs = pairs.slice(-PAIR_WINDOW);
      refit();
    },
    /**
     * One observation while the student is typing (they look at the screen most of the time).
     * `target` is the focused field's centre (or the screen centre when unknown).
     */
    observeTyping(input: {
      readonly t: number;
      readonly target: ScreenPoint;
      readonly eyes: RawAngles | null;
      readonly head: RawAngles;
    }): void {
      const learning = confidenceOf(false) < CALIBRATED_CONFIDENCE;
      if (input.eyes !== null)
        stepDrift(eyeDrift, eyeFit, input.eyes, input.target, input.t, false, learning);
      stepDrift(
        headDrift,
        headFit,
        input.head,
        input.target,
        input.t,
        true,
        confidenceOf(true) < CALIBRATED_CONFIDENCE,
      );
    },
    /** Current calibration for the eye model, or the head-only model when eyes are unreliable. */
    calibration(headOnly = false): GazeCalibration {
      const fit = headOnly ? headFit : eyeFit;
      const drift = headOnly ? headDrift : eyeDrift;
      const y = model(fit, 'yaw', headOnly);
      const p = model(fit, 'pitch', headOnly);
      const confidence = confidenceOf(headOnly);
      const ext = geometry.extent;
      // Calibrated zone: screen extent with the usual margin plus the fit's own noise (2 sigma,
      // in calibrated degrees), so tracker jitter at the screen edge is not a look-away.
      const noise = (key: 'yaw' | 'pitch') => {
        const f = headOnly ? null : fit[key];
        return f ? (RESIDUAL_SIGMAS * f.sigma) / Math.abs(f.slope) : 0;
      };
      const calibratedZone = {
        yaw: ext.yaw * CALIBRATED_MARGIN + noise('yaw'),
        pitch: ext.pitch * CALIBRATED_MARGIN + noise('pitch'),
      };
      const lerp = (lo: number, hi: number) => Math.max(lo, hi + (lo - hi) * confidence);
      const zone = {
        yaw:
          lerp(calibratedZone.yaw, geometry.learningZone.yaw) +
          (headOnly ? HEAD_ONLY_SLACK.yaw : 0),
        pitch:
          lerp(calibratedZone.pitch, geometry.learningZone.pitch) +
          (headOnly ? HEAD_ONLY_SLACK.pitch : 0),
      };
      return {
        kind: 'auto',
        headOffset: { yaw: y.offset + drift.yaw, pitch: p.offset + drift.pitch, roll: 0 },
        eyeOffset: { yaw: 0, pitch: 0 },
        // Head-only: the head moves only part of the way, so keep unit gain (degrees of head
        // turn) and rely on the wider zone instead of amplifying head noise.
        gain: headOnly ? { yaw: 1, pitch: 1 } : { yaw: 1 / y.slope, pitch: 1 / p.slope },
        extent: ext,
        zone,
        confidence,
        headOnly,
      };
    },
    state(headOnly = false): AutoCalibrationState {
      const confidence = confidenceOf(headOnly);
      return {
        phase: confidence >= CALIBRATED_CONFIDENCE ? 'calibrated' : 'learning',
        confidence,
        pairs: pairs.length,
        headOnly,
        distanceMm: geometry.distanceMm,
        gainFitted: {
          yaw: eyeFit.yaw?.gainFitted ?? false,
          pitch: eyeFit.pitch?.gainFitted ?? false,
        },
        postureResets,
      };
    },
    geometry: () => geometry,
    reset(): void {
      clearLearning();
      distance = DEFAULT_DISTANCE_MM;
      distanceT = null;
      geometry = screenGeometry(distance, screen);
      fitExtent = geometry.extent;
      baseline = null;
      recentFaces = [];
      deviatingSince = null;
      sign.yaw = 1;
      sign.pitch = 1;
      postureResets = 0;
    },
  };
}
export type ImplicitCalibrator = ReturnType<typeof createImplicitCalibrator>;
