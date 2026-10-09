/**
 * Pure lighting analysis for the exam webcam. Input is a few small luminance frames (0..255, the
 * same 64x64 style as cameraGate.ts) and, when available, the normalised MediaPipe face box. No
 * image ever leaves this module: only numbers and fix tips come out.
 */
import type { FeedFrame } from './cameraGate.js';
import type { Box } from './gazeEstimator.js';

export type LightingClass = 'good' | 'dim' | 'too_dark' | 'backlit' | 'overexposed' | 'uneven';

export interface LightingMetrics {
  /** Mean luminance of the face (or of the centre of the picture when no face box is known). */
  readonly faceMean: number;
  /** False when the face box was missing and the centre of the picture was used instead. */
  readonly faceKnown: boolean;
  /** Mean luminance outside the face; null when the face fills the whole picture. */
  readonly backgroundMean: number | null;
  /** Background minus face; large and positive means backlit (a window or lamp behind you). */
  readonly contrast: number | null;
  readonly overallMean: number;
  /** Percent of face pixels at or near white. */
  readonly clippedPct: number;
  /** Percent of the whole picture at or near black. */
  readonly crushedPct: number;
  /** Temporal noise (luminance standard deviation); 0 when only one frame was available. */
  readonly noise: number;
  /** Left/right face brightness difference, 0 (even) .. 1 (one side dark); null without a face. */
  readonly asymmetry: number | null;
  /** Which side of the picture is brighter, when asymmetric. */
  readonly brighterSide: 'left' | 'right' | null;
}

export interface LightingReport {
  readonly class: LightingClass;
  readonly metrics: LightingMetrics;
  readonly headline: string;
  readonly tips: readonly string[];
}

export interface LightingInput {
  readonly frames: readonly FeedFrame[];
  readonly width?: number;
  readonly height?: number;
  readonly faceBox?: Box | null;
}

export const LIGHTING_THRESHOLDS = {
  tooDark: 45,
  dim: 80,
  overexposedMean: 205,
  overexposedClipped: 18,
  backlitContrast: 45,
  backlitBackground: 125,
  backlitFaceMax: 125,
  unevenAsymmetry: 0.3,
  clipLevel: 250,
  crushLevel: 12,
} as const;

/** When no face box is known, the middle of the picture stands in for the face. */
const CENTRE_BOX: Box = { x: 0.3, y: 0.2, w: 0.4, h: 0.55 };

export const LIGHTING_HEADLINES: Record<LightingClass, string> = {
  good: 'Lighting looks good',
  dim: 'Your face is a little dim',
  too_dark: 'Your face is too dark',
  backlit: 'You are backlit',
  overexposed: 'Your face is too bright',
  uneven: 'The light is hitting one side of your face',
};

export const LIGHTING_TIPS: Record<LightingClass, readonly string[]> = {
  good: [],
  dim: [
    'Turn on a light in front of you, facing your face.',
    'Raise screen brightness.',
    'Turn on "Boost light" to use your screen as a soft light.',
  ],
  too_dark: [
    'Turn on a light in front of you, facing your face.',
    'Raise screen brightness.',
    'Turn on "Boost light" to use your screen as a soft light.',
    'Open the curtains or face a window (the window in front of you, not behind).',
  ],
  backlit: [
    "Don't sit with a window or bright lamp behind you.",
    'Turn around so the window is in front of you or to the side.',
    'Turn on a light in front of you, or close the curtains behind you.',
  ],
  overexposed: [
    'Lower your screen brightness a little, or turn off "Boost light".',
    'Move the lamp further away, or point it at the wall instead of your face.',
  ],
  uneven: [
    "Move the lamp so it's in front, not to the side.",
    'Face the main light source, or add a second light on the darker side.',
  ],
};

interface Region {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

function regionOf(box: Box, width: number, height: number): Region {
  const x0 = Math.floor(clampUnit(box.x) * width);
  const y0 = Math.floor(clampUnit(box.y) * height);
  const x1 = Math.ceil(clampUnit(box.x + box.w) * width);
  const y1 = Math.ceil(clampUnit(box.y + box.h) * height);
  return { x0, y0, x1: Math.max(x1, x0 + 1), y1: Math.max(y1, y0 + 1) };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

/** Temporal noise: median over frame pairs of std(diff) / sqrt(2). */
function temporalNoise(frames: readonly FeedFrame[]): number {
  const stds: number[] = [];
  for (let f = 1; f < frames.length; f += 1) {
    const a = frames[f - 1]!;
    const b = frames[f]!;
    const n = Math.min(a.length, b.length);
    if (n === 0) continue;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const d = b[i]! - a[i]!;
      sum += d;
      sumSq += d * d;
    }
    const mean = sum / n;
    stds.push(Math.sqrt(Math.max(0, sumSq / n - mean * mean)) / Math.SQRT2);
  }
  return median(stds);
}

/** Compute every lighting number from the latest frame (noise uses all frames). */
export function lightingMetrics(input: LightingInput): LightingMetrics | null {
  const frame = input.frames[input.frames.length - 1];
  if (!frame || frame.length === 0) return null;
  const width = input.width ?? 64;
  const height = input.height ?? Math.floor(frame.length / width);
  if (width <= 0 || height <= 0 || frame.length < width * height) return null;
  const faceBox = input.faceBox ?? null;
  const faceKnown = faceBox !== null && faceBox.w > 0 && faceBox.h > 0;
  const face = regionOf(faceKnown ? faceBox : CENTRE_BOX, width, height);
  // Background excludes a margin around the face so hair and neck do not dilute the contrast.
  const marginX = Math.ceil((face.x1 - face.x0) * 0.15);
  const marginY = Math.ceil((face.y1 - face.y0) * 0.15);
  const keepOut: Region = {
    x0: face.x0 - marginX,
    y0: face.y0 - marginY,
    x1: face.x1 + marginX,
    y1: face.y1 + marginY,
  };
  const midX = Math.floor((face.x0 + face.x1) / 2);
  let faceSum = 0;
  let faceCount = 0;
  let clipped = 0;
  let leftSum = 0;
  let leftCount = 0;
  let rightSum = 0;
  let rightCount = 0;
  let bgSum = 0;
  let bgCount = 0;
  let total = 0;
  let crushed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = frame[y * width + x]!;
      total += v;
      if (v <= LIGHTING_THRESHOLDS.crushLevel) crushed += 1;
      if (x >= face.x0 && x < face.x1 && y >= face.y0 && y < face.y1) {
        faceSum += v;
        faceCount += 1;
        if (v >= LIGHTING_THRESHOLDS.clipLevel) clipped += 1;
        if (x < midX) {
          leftSum += v;
          leftCount += 1;
        } else {
          rightSum += v;
          rightCount += 1;
        }
      } else if (x < keepOut.x0 || x >= keepOut.x1 || y < keepOut.y0 || y >= keepOut.y1) {
        bgSum += v;
        bgCount += 1;
      }
    }
  }
  const pixels = width * height;
  const faceMean = faceCount > 0 ? faceSum / faceCount : total / pixels;
  const backgroundMean = bgCount > 0 ? bgSum / bgCount : null;
  let asymmetry: number | null = null;
  let brighterSide: 'left' | 'right' | null = null;
  if (faceKnown && leftCount > 0 && rightCount > 0) {
    const left = leftSum / leftCount;
    const right = rightSum / rightCount;
    asymmetry = Math.abs(left - right) / Math.max(left, right, 1);
    brighterSide = left === right ? null : left > right ? 'left' : 'right';
  }
  return {
    faceMean,
    faceKnown,
    backgroundMean,
    contrast: backgroundMean === null ? null : backgroundMean - faceMean,
    overallMean: total / pixels,
    clippedPct: faceCount > 0 ? (clipped / faceCount) * 100 : 0,
    crushedPct: (crushed / pixels) * 100,
    noise: temporalNoise(input.frames),
    asymmetry,
    brighterSide,
  };
}

export function classifyLighting(metrics: LightingMetrics): LightingClass {
  const t = LIGHTING_THRESHOLDS;
  if (metrics.faceMean >= t.overexposedMean || metrics.clippedPct >= t.overexposedClipped)
    return 'overexposed';
  if (
    metrics.contrast !== null &&
    metrics.backgroundMean !== null &&
    metrics.contrast >= t.backlitContrast &&
    metrics.backgroundMean >= t.backlitBackground &&
    metrics.faceMean <= t.backlitFaceMax
  )
    return 'backlit';
  if (metrics.faceMean < t.tooDark) return 'too_dark';
  if (metrics.faceMean < t.dim) return 'dim';
  if (metrics.asymmetry !== null && metrics.asymmetry >= t.unevenAsymmetry) return 'uneven';
  return 'good';
}

/** Full report: numbers, class, headline and specific fix tips. Null when there is no usable frame. */
export function analyseLighting(input: LightingInput): LightingReport | null {
  const metrics = lightingMetrics(input);
  if (metrics === null) return null;
  const cls = classifyLighting(metrics);
  const tips = [...LIGHTING_TIPS[cls]];
  if ((cls === 'dim' || cls === 'too_dark') && metrics.noise >= 6)
    tips.push('The picture is grainy, which usually means the room is too dark for this camera.');
  return { class: cls, metrics, headline: LIGHTING_HEADLINES[cls], tips };
}

/** Classes where the face tracker is likely to struggle; in-exam monitoring only warns for these. */
export function isPoorLighting(cls: LightingClass): boolean {
  return cls === 'too_dark' || cls === 'backlit';
}

/** Face-brightness change from a "before" to an "after" report, e.g. with the light boost on. */
export function lightingImprovement(before: LightingReport, after: LightingReport): number {
  return Math.round((after.metrics.faceMean - before.metrics.faceMean) * 10) / 10;
}

/** The lighting event name logged to the unified timeline, e.g. `lighting_poor_backlit`. */
export function lightingEventName(cls: LightingClass): string {
  return `lighting_poor_${cls}`;
}
