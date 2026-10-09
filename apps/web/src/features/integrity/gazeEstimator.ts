/**
 * Pure on-device eye-gaze maths. Gaze = head pose + eye-in-head direction.
 *
 * Conventions (all degrees, camera-relative, same as faceDirection.ts):
 *   yaw   > 0  toward the right of the camera image
 *   pitch > 0  up
 *   bearing 0 = N (up), 90 = E (right), 180 = S (down, desk or lap), 270 = W.
 *
 * Eye-in-head direction comes from two independent sources that are blended:
 *   (a) iris landmarks of the 478-point FaceLandmarker mesh, relative to the eye corners/lids;
 *   (b) the eyeLookIn/Out/Up/Down blendshapes.
 * Accuracy from a webcam is roughly +-5 to 10 degrees; glasses, glare and low light make it worse.
 * Nothing here is proof of anything: it is an estimate of where the face and eyes point.
 */
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}
export interface BlendCategory {
  readonly categoryName: string;
  readonly score: number;
}
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Eye-in-head signals for one frame. null = that source was unavailable. */
export interface EyeFeatures {
  /** -1..1 iris offset along the eye axis; + = toward image right. Typical gaze range is +-0.4. */
  readonly irisH: number | null;
  /** -1..1 iris offset from lid midline; + = up. */
  readonly irisV: number | null;
  /** -1..1 blendshape horizontal estimate; + = toward image right (before sign learning). */
  readonly blendH: number | null;
  /** -1..1 blendshape vertical estimate; + = up. */
  readonly blendV: number | null;
  /** 0..1 mean blink blendshape (or lid-closure proxy). */
  readonly blink: number;
}

export interface Angles {
  readonly yaw: number;
  readonly pitch: number;
}

export const IRIS_YAW_GAIN = 55;
export const BLEND_YAW_GAIN = 28;
export const IRIS_PITCH_GAIN = 30;
export const BLEND_PITCH_GAIN = 25;
export const BLINK_INVALID = 0.5;
export const MAX_EYE_DEGREES = 40;

const RIGHT_EYE = { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468 } as const;
const LEFT_EYE = { inner: 362, outer: 263, upper: 386, lower: 374, iris: 473 } as const;
export const IRIS_LANDMARK_COUNT = 478;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number | undefined | null): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export function wrapDegrees(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

/** Normalised eye geometry for one eye. Null when the eye is closed or degenerate. */
function eyeGeometry(
  mesh: readonly Landmark[],
  e: { upper: number; lower: number; iris: number },
  left: number,
  right: number,
): { h: number; v: number; openness: number } | null {
  const p1 = mesh[left];
  const p2 = mesh[right];
  const up = mesh[e.upper];
  const low = mesh[e.lower];
  const iris = mesh[e.iris];
  if (!p1 || !p2 || !up || !low || !iris) return null;
  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;
  const length = Math.hypot(ax, ay);
  if (!(length > 1e-6)) return null;
  const ux = ax / length;
  const uy = ay / length;
  // Image-up unit vector relative to the eye axis (image y grows downward).
  const nx = uy;
  const ny = -ux;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const h = ((iris.x - mx) * ux + (iris.y - my) * uy) / (length / 2);
  // Lid opening measured along image-down (positive when the eye is open).
  const lidHeight = (low.x - up.x) * -nx + (low.y - up.y) * -ny;
  const openness = lidHeight / length;
  if (!(openness > 0.1)) return null;
  const lidMidX = (up.x + low.x) / 2;
  const lidMidY = (up.y + low.y) / 2;
  const v = ((iris.x - lidMidX) * nx + (iris.y - lidMidY) * ny) / (lidHeight / 2);
  return { h, v, openness };
}

function blend(categories: readonly BlendCategory[] | undefined, name: string): number | null {
  const hit = categories?.find((c) => c.categoryName === name);
  return hit !== undefined && finite(hit.score) ? hit.score : null;
}

/** Reads iris geometry + blendshapes. Returns null when neither source is usable. */
export function extractEyeFeatures(
  mesh: readonly Landmark[] | undefined,
  categories: readonly BlendCategory[] | undefined,
): EyeFeatures | null {
  let irisH: number | null = null;
  let irisV: number | null = null;
  let openness: number | null = null;
  if (mesh !== undefined && mesh.length >= IRIS_LANDMARK_COUNT) {
    const r = eyeGeometry(mesh, RIGHT_EYE, RIGHT_EYE.outer, RIGHT_EYE.inner);
    const l = eyeGeometry(mesh, LEFT_EYE, LEFT_EYE.inner, LEFT_EYE.outer);
    const eyes = [r, l].filter((e): e is NonNullable<typeof e> => e !== null);
    if (eyes.length > 0) {
      irisH = eyes.reduce((a, e) => a + e.h, 0) / eyes.length;
      irisV = eyes.reduce((a, e) => a + e.v, 0) / eyes.length;
      openness = eyes.reduce((a, e) => a + e.openness, 0) / eyes.length;
    }
  }
  const rIn = blend(categories, 'eyeLookInRight');
  const rOut = blend(categories, 'eyeLookOutRight');
  const lIn = blend(categories, 'eyeLookInLeft');
  const lOut = blend(categories, 'eyeLookOutLeft');
  const up = [blend(categories, 'eyeLookUpRight'), blend(categories, 'eyeLookUpLeft')];
  const down = [blend(categories, 'eyeLookDownRight'), blend(categories, 'eyeLookDownLeft')];
  let blendH: number | null = null;
  if (rIn !== null && rOut !== null && lIn !== null && lOut !== null)
    blendH = (rIn - rOut + (lOut - lIn)) / 2;
  let blendV: number | null = null;
  if (up.every(finite) && down.every(finite))
    blendV = (up[0]! + up[1]! - (down[0]! + down[1]!)) / 2;
  const blinkL = blend(categories, 'eyeBlinkLeft');
  const blinkR = blend(categories, 'eyeBlinkRight');
  let blink = blinkL !== null && blinkR !== null ? (blinkL + blinkR) / 2 : 0;
  if (blinkL === null && blinkR === null && openness === null && irisH === null) blink = 0;
  if (irisH === null && blendH === null && blendV === null) return null;
  return { irisH, irisV, blendH, blendV, blink };
}

/**
 * Learns whether the blendshape "Left/Right" naming matches the iris horizontal sign by
 * correlating the two signals over time. Returns +1 until there is enough evidence.
 */
export function createBlendSignLearner() {
  let dot = 0;
  let energy = 0;
  return {
    add(irisH: number | null, blendH: number | null): void {
      if (irisH === null || blendH === null) return;
      if (Math.abs(irisH) < 0.08 || Math.abs(blendH) < 0.08) return; // ignore near-centre noise
      dot = dot * 0.995 + irisH * blendH;
      energy = energy * 0.995 + Math.abs(irisH * blendH);
    },
    sign(): 1 | -1 {
      return energy > 0.15 && dot < -0.4 * energy ? -1 : 1;
    },
    reset(): void {
      dot = energy = 0;
    },
  };
}

/** Eye-in-head offset in degrees, or null while blinking / without any eye signal. */
export function eyeOffsetDegrees(eye: EyeFeatures | null, blendSign: 1 | -1 = 1): Angles | null {
  if (eye === null || eye.blink > BLINK_INVALID) return null;
  const axis = (
    iris: number | null,
    bl: number | null,
    gi: number,
    gb: number,
    wi: number,
  ): number => {
    const a = iris !== null ? iris * gi : null;
    const b = bl !== null ? bl * gb : null;
    if (a !== null && b !== null) return wi * a + (1 - wi) * b;
    return a ?? b ?? 0;
  };
  const yaw = axis(
    eye.irisH,
    eye.blendH === null ? null : eye.blendH * blendSign,
    IRIS_YAW_GAIN,
    BLEND_YAW_GAIN,
    0.5,
  );
  const pitch = axis(eye.irisV, eye.blendV, IRIS_PITCH_GAIN, BLEND_PITCH_GAIN, 0.35);
  return {
    yaw: clamp(yaw, -MAX_EYE_DEGREES, MAX_EYE_DEGREES),
    pitch: clamp(pitch, -MAX_EYE_DEGREES, MAX_EYE_DEGREES),
  };
}

/** Roll about the viewing axis from a MediaPipe column-major transform. */
export function rollFromMatrix(data: readonly number[]): number | null {
  if (data.length !== 16 || data.some((v) => !Number.isFinite(v))) return null;
  return (Math.atan2(data[1]!, data[0]!) * 180) / Math.PI;
}

export function faceBoxFromLandmarks(mesh: readonly Landmark[]): Box | null {
  if (mesh.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of mesh) {
    if (!finite(p.x) || !finite(p.y)) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 0..1 tracking-quality proxy (FaceLandmarker exposes no per-face score): face size in frame,
 * face fully inside the frame, iris landmarks present and eyes open enough to read.
 */
export function trackingQuality(input: {
  readonly box: Box | null;
  readonly hasIris: boolean;
  readonly poseOk: boolean;
  readonly blink: number;
}): number {
  if (input.box === null) return 0;
  const size = clamp(input.box.w / 0.18, 0, 1);
  const inside =
    input.box.x >= -0.01 &&
    input.box.y >= -0.01 &&
    input.box.x + input.box.w <= 1.01 &&
    input.box.y + input.box.h <= 1.01
      ? 1
      : 0.6;
  const score =
    0.4 * size + 0.2 * inside + 0.2 * (input.hasIris ? 1 : 0) + 0.2 * (input.poseOk ? 1 : 0);
  return clamp(score * (input.blink > BLINK_INVALID ? 0.7 : 1), 0, 1);
}

// ---------------------------------------------------------------- compass helpers

export const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Sector = (typeof SECTORS)[number];

/** 0 = N, clockwise, 0..360. */
export function bearingDegrees(yaw: number, pitch: number): number {
  const b = (Math.atan2(yaw, pitch) * 180) / Math.PI;
  return (b + 360) % 360;
}
export function sectorIndex(bearing: number): number {
  return Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
}
export function sectorOf(yaw: number, pitch: number): Sector {
  return SECTORS[sectorIndex(bearingDegrees(yaw, pitch))]!;
}

export interface Extent {
  readonly yaw: number;
  readonly pitch: number;
}
/** Screen-corner half-extents in gaze degrees (typical laptop at arm's length). */
export const DEFAULT_EXTENT: Extent = { yaw: 18, pitch: 11 };
const ZONE_MARGIN = 1.25;
/** On-screen rectangle half-extents: the screen corners plus a tolerance margin. */
export function zoneOf(extent: Extent): Extent {
  return { yaw: extent.yaw * ZONE_MARGIN, pitch: extent.pitch * ZONE_MARGIN };
}

/** Degrees by which a gaze lies beyond the on-screen rectangle along its own direction. */
export function offScreenDegrees(yaw: number, pitch: number, zone: Extent): number {
  if (Math.abs(yaw) <= zone.yaw && Math.abs(pitch) <= zone.pitch) return 0;
  const magnitude = Math.hypot(yaw, pitch);
  const s = Math.abs(yaw) / magnitude;
  const c = Math.abs(pitch) / magnitude;
  const radius = Math.min(s > 1e-9 ? zone.yaw / s : Infinity, c > 1e-9 ? zone.pitch / c : Infinity);
  return Math.max(0, magnitude - radius);
}

// ---------------------------------------------------------------- raw gaze + calibration

export interface RawGaze {
  readonly headYaw: number;
  readonly headPitch: number;
  readonly headRoll: number;
  readonly eyeYaw: number;
  readonly eyePitch: number;
  readonly eyesValid: boolean;
}

export function rawGaze(
  pose: { readonly yaw: number; readonly pitch: number },
  roll: number | null,
  eye: Angles | null,
): RawGaze {
  return {
    headYaw: pose.yaw,
    headPitch: pose.pitch,
    headRoll: roll ?? 0,
    eyeYaw: eye?.yaw ?? 0,
    eyePitch: eye?.pitch ?? 0,
    eyesValid: eye !== null,
  };
}

export type CalibrationKind = 'none' | 'centre' | 'five-point';
export interface GazeCalibration {
  readonly kind: CalibrationKind;
  readonly headOffset: { readonly yaw: number; readonly pitch: number; readonly roll: number };
  readonly eyeOffset: Angles;
  /** Multiplies (head + eye) so that a screen corner reads as +-extent. */
  readonly gain: Angles;
  readonly extent: Extent;
}
export const NO_CALIBRATION: GazeCalibration = {
  kind: 'none',
  headOffset: { yaw: 0, pitch: 0, roll: 0 },
  eyeOffset: { yaw: 0, pitch: 0 },
  gain: { yaw: 1, pitch: 1 },
  extent: DEFAULT_EXTENT,
};

export interface GazeAngles {
  /** Final calibrated gaze (head + eyes, gain applied). */
  readonly yaw: number;
  readonly pitch: number;
  readonly headYaw: number;
  readonly headPitch: number;
  readonly headRoll: number;
  readonly eyeYaw: number;
  readonly eyePitch: number;
}

export function applyCalibration(raw: RawGaze, cal: GazeCalibration): GazeAngles {
  const headYaw = wrapDegrees(raw.headYaw - cal.headOffset.yaw);
  const headPitch = wrapDegrees(raw.headPitch - cal.headOffset.pitch);
  const headRoll = wrapDegrees(raw.headRoll - cal.headOffset.roll);
  const eyeYaw = raw.eyeYaw - cal.eyeOffset.yaw;
  const eyePitch = raw.eyePitch - cal.eyeOffset.pitch;
  return {
    yaw: (headYaw + eyeYaw) * cal.gain.yaw,
    pitch: (headPitch + eyePitch) * cal.gain.pitch,
    headYaw,
    headPitch,
    headRoll,
    eyeYaw,
    eyePitch,
  };
}

export type CalibrationTarget = 'centre' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
export const CALIBRATION_ORDER: readonly CalibrationTarget[] = [
  'centre',
  'topLeft',
  'topRight',
  'bottomRight',
  'bottomLeft',
];
const CORNER_SIGNS: Record<Exclude<CalibrationTarget, 'centre'>, { x: 1 | -1; y: 1 | -1 }> = {
  topLeft: { x: -1, y: 1 },
  topRight: { x: 1, y: 1 },
  bottomLeft: { x: -1, y: -1 },
  bottomRight: { x: 1, y: -1 },
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function medianRaw(samples: readonly RawGaze[]) {
  const eyes = samples.filter((s) => s.eyesValid);
  const ref = samples[0]!;
  const unwrap = (v: number, r: number) => r + wrapDegrees(v - r);
  return {
    headYaw: median(samples.map((s) => unwrap(s.headYaw, ref.headYaw))),
    headPitch: median(samples.map((s) => unwrap(s.headPitch, ref.headPitch))),
    headRoll: median(samples.map((s) => unwrap(s.headRoll, ref.headRoll))),
    eyeYaw: median(eyes.map((s) => s.eyeYaw)),
    eyePitch: median(eyes.map((s) => s.eyePitch)),
  };
}

export interface CalibrationFit {
  readonly calibration: GazeCalibration;
  readonly warnings: readonly string[];
}

const MIN_POINT_SAMPLES = 2;
const MIN_SPREAD_DEGREES = 3;
const GAIN_RANGE = [0.4, 3] as const;

/**
 * Fits an offset (centre) and, with at least three corners, a per-axis gain/sign so the
 * corners read as +-extent. Returns null without a usable centre capture. Centre-only gives
 * kind "centre" with unit gain.
 */
export function fitCalibration(
  samples: Partial<Record<CalibrationTarget, readonly RawGaze[]>>,
  extent: Extent = DEFAULT_EXTENT,
): CalibrationFit | null {
  const centreSamples = samples.centre ?? [];
  if (centreSamples.length < MIN_POINT_SAMPLES) return null;
  const c = medianRaw(centreSamples);
  const warnings: string[] = [];
  let gain: Angles = { yaw: 1, pitch: 1 };
  let kind: CalibrationKind = 'centre';
  const xs: number[] = [];
  const ys: number[] = [];
  for (const key of Object.keys(CORNER_SIGNS) as Array<keyof typeof CORNER_SIGNS>) {
    const pts = samples[key] ?? [];
    if (pts.length < MIN_POINT_SAMPLES) continue;
    const p = medianRaw(pts);
    const dx = wrapDegrees(p.headYaw - c.headYaw) + (p.eyeYaw - c.eyeYaw);
    const dy = wrapDegrees(p.headPitch - c.headPitch) + (p.eyePitch - c.eyePitch);
    xs.push(dx * CORNER_SIGNS[key].x);
    ys.push(dy * CORNER_SIGNS[key].y);
  }
  if (xs.length >= 3) {
    kind = 'five-point';
    const axis = (values: number[], target: number, label: string): number => {
      const m = values.reduce((a, b) => a + b, 0) / values.length;
      if (Math.abs(m) < MIN_SPREAD_DEGREES) {
        warnings.push(`${label} movement was too small to measure; default scale kept.`);
        return 1;
      }
      return Math.sign(m) * clamp(target / Math.abs(m), GAIN_RANGE[0], GAIN_RANGE[1]);
    };
    gain = {
      yaw: axis(xs, extent.yaw, 'Sideways'),
      pitch: axis(ys, extent.pitch, 'Up/down'),
    };
  } else if (Object.keys(samples).length > 1) {
    warnings.push('Not enough corner readings; used the centre only.');
  }
  return {
    calibration: {
      kind,
      headOffset: { yaw: c.headYaw, pitch: c.headPitch, roll: c.headRoll },
      eyeOffset: { yaw: c.eyeYaw, pitch: c.eyePitch },
      gain,
      extent,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- One-Euro filter

/** One-Euro filter (Casiez et al.) with explicit timestamps; handles irregular sampling. */
export function createOneEuro(minCutoff = 1.5, beta = 0.08, dCutoff = 1) {
  let lastT: number | null = null;
  let x = 0;
  let dx = 0;
  const alpha = (cutoff: number, dt: number) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return {
    filter(value: number, tMs: number): number {
      if (lastT === null) {
        lastT = tMs;
        x = value;
        dx = 0;
        return x;
      }
      if (tMs <= lastT) return x;
      const dt = (tMs - lastT) / 1000;
      lastT = tMs;
      const rate = (value - x) / dt;
      dx = dx + alpha(dCutoff, dt) * (rate - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x = x + alpha(cutoff, dt) * (value - x);
      return x;
    },
    reset(): void {
      lastT = null;
    },
  };
}

// ---------------------------------------------------------------- sample

export interface GazeSample {
  /** Monotonic milliseconds (performance.now) of the observation. */
  readonly t: number;
  /** Smoothed, calibrated gaze degrees. */
  readonly yaw: number;
  readonly pitch: number;
  readonly headYaw: number;
  readonly headPitch: number;
  readonly headRoll: number;
  readonly eyeYaw: number;
  readonly eyePitch: number;
  /** Total angle away from the calibrated centre. */
  readonly magnitude: number;
  /** 0 = N (up), 90 = E (right), 180 = S (down). */
  readonly bearing: number;
  readonly sector: Sector;
  readonly onScreen: boolean;
  /** Degrees beyond the on-screen rectangle (0 when on screen). */
  readonly offScreenDeg: number;
  readonly zone: Extent;
  /** False when blinking/no eye signal: eyes were held or ignored for this frame. */
  readonly eyesValid: boolean;
  /** 0..1 tracking-quality proxy. */
  readonly quality: number;
  readonly calibration: CalibrationKind;
}

export function buildSample(
  t: number,
  angles: GazeAngles,
  smooth: Angles,
  cal: GazeCalibration,
  eyesValid: boolean,
  quality: number,
): GazeSample {
  const zone = zoneOf(cal.extent);
  const magnitude = Math.hypot(smooth.yaw, smooth.pitch);
  const off = offScreenDegrees(smooth.yaw, smooth.pitch, zone);
  return {
    t,
    yaw: smooth.yaw,
    pitch: smooth.pitch,
    headYaw: angles.headYaw,
    headPitch: angles.headPitch,
    headRoll: angles.headRoll,
    eyeYaw: angles.eyeYaw,
    eyePitch: angles.eyePitch,
    magnitude,
    bearing: bearingDegrees(smooth.yaw, smooth.pitch),
    sector: sectorOf(smooth.yaw, smooth.pitch),
    onScreen: off === 0,
    offScreenDeg: off,
    zone,
    eyesValid,
    quality,
    calibration: cal.kind,
  };
}

/** "S 18°" style label: nearest compass sector plus total degrees off centre. */
export function bearingLabel(sample: Pick<GazeSample, 'sector' | 'magnitude'>): string {
  return `${sample.sector} ${Math.round(sample.magnitude)}°`;
}
