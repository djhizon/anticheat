import { clampRect, type Rect, type WearableDetection } from './wearablesCore.js';

/** A normalised (0..1) image point. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A few MediaPipe face-mesh landmarks (normalised frame coordinates), enough to place crops.
 * "Left/right" are image sides, not the person's.
 */
export interface FaceKeypoints {
  /** Landmark 234: face contour next to the ear on the image-left side. */
  readonly earLeft: Point;
  /** Landmark 454: face contour next to the ear on the image-right side. */
  readonly earRight: Point;
  /** Landmark 33 / 263: outer eye corners. */
  readonly eyeLeft: Point;
  readonly eyeRight: Point;
  /** Landmark 10 (top of the forehead) and 152 (chin). */
  readonly forehead: Point;
  readonly chin: Point;
}

/** Landmark indices read by the vision worker, in FaceKeypoints field order. */
export const KEYPOINT_LANDMARKS = {
  earLeft: 234,
  earRight: 454,
  eyeLeft: 33,
  eyeRight: 263,
  forehead: 10,
  chin: 152,
} as const;

export function keypointsFromMesh(
  mesh: readonly { readonly x: number; readonly y: number }[] | undefined,
): FaceKeypoints | null {
  if (mesh === undefined) return null;
  const pick = (index: number): Point | null => {
    const p = mesh[index];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  };
  const out: Record<string, Point> = {};
  for (const [name, index] of Object.entries(KEYPOINT_LANDMARKS)) {
    const p = pick(index);
    if (p === null) return null;
    out[name] = p;
  }
  return out as unknown as FaceKeypoints;
}

export interface HeadGeometry {
  /** Square (in pixels) crop around the head, ears and neck: the 'head' view. */
  readonly head: Rect;
  /** Regions an earbud or a headphone cup must touch. */
  readonly ears: readonly [Rect, Rect];
  /** Band across both eyes that a pair of glasses must touch. */
  readonly eyes: Rect;
}

/**
 * Crop geometry from landmarks. Distances are measured in pixels (the frame is rarely square) and
 * converted back to normalised units. The head crop is about 2.1 face widths wide so ear-worn
 * devices and headbands sit well inside it; the model then sees them at 2-4x the frame resolution.
 */
export function headGeometry(
  kp: FaceKeypoints,
  frameW: number,
  frameH: number,
): HeadGeometry | null {
  if (!(frameW > 0 && frameH > 0)) return null;
  const px = (p: Point) => ({ x: p.x * frameW, y: p.y * frameH });
  const l = px(kp.earLeft);
  const r = px(kp.earRight);
  const top = px(kp.forehead);
  const chin = px(kp.chin);
  const faceW = Math.hypot(r.x - l.x, r.y - l.y);
  const faceH = Math.hypot(chin.x - top.x, chin.y - top.y);
  if (!(faceW > 4 && faceH > 4)) return null;

  const cx = (l.x + r.x) / 2;
  const cy = (top.y + chin.y) / 2 + 0.1 * faceH;
  let side = Math.max(2.1 * faceW, 1.9 * faceH);
  side = Math.min(side, frameW, frameH);
  const x = Math.min(Math.max(cx - side / 2, 0), frameW - side);
  const y = Math.min(Math.max(cy - side / 2, 0), frameH - side);
  const head = { x: x / frameW, y: y / frameH, w: side / frameW, h: side / frameH };

  const ear = (p: { x: number; y: number }, outward: number): Rect => {
    const w = 0.5 * faceW;
    const h = 0.8 * faceH;
    const ex = p.x + outward * 0.1 * faceW;
    const ey = p.y + 0.1 * faceH;
    return clampRect({
      x: (ex - w / 2) / frameW,
      y: (ey - h / 2) / frameH,
      w: w / frameW,
      h: h / frameH,
    });
  };
  const eyeL = px(kp.eyeLeft);
  const eyeR = px(kp.eyeRight);
  const eyeY = (eyeL.y + eyeR.y) / 2;
  const eyes = clampRect({
    x: (Math.min(eyeL.x, eyeR.x) - 0.2 * faceW) / frameW,
    y: (eyeY - 0.2 * faceH) / frameH,
    w: (Math.abs(eyeR.x - eyeL.x) + 0.4 * faceW) / frameW,
    h: (0.4 * faceH) / frameH,
  });
  return { head, ears: [ear(l, -1), ear(r, 1)], eyes };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Drops detections that cannot be the student's own wearable: earbuds must touch an ear region,
 * glasses the eye band and headphones an ear region. Without landmarks nothing is filtered.
 */
export function plausibleDetections(
  detections: readonly WearableDetection[],
  geometry: HeadGeometry | null,
): WearableDetection[] {
  if (geometry === null) return [...detections];
  return detections.filter((d) => {
    if (d.cls === 'earbuds' || d.cls === 'headphones') {
      return geometry.ears.some((ear) => intersects(ear, d.box));
    }
    if (d.cls === 'glasses') return intersects(geometry.eyes, d.box);
    return true;
  });
}
