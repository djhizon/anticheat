import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENT,
  NO_CALIBRATION,
  applyCalibration,
  bearingDegrees,
  createBlendSignLearner,
  createOneEuro,
  extractEyeFeatures,
  eyeOffsetDegrees,
  faceBoxFromLandmarks,
  fitCalibration,
  offScreenDegrees,
  rawGaze,
  rollFromMatrix,
  sectorOf,
  trackingQuality,
  wrapDegrees,
  zoneOf,
  type Landmark,
  type RawGaze,
} from './gazeEstimator.js';

/** Synthetic 478-point mesh with both eyes open; iris offsets are in normalised image units. */
function mesh(irisDx = 0, irisDy = 0, open = 0.015): Landmark[] {
  const points: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  // Subject's right eye (image left): outer 33, inner 133. Eye width 0.06.
  points[33] = { x: 0.4, y: 0.4 };
  points[133] = { x: 0.46, y: 0.4 };
  points[159] = { x: 0.43, y: 0.4 - open };
  points[145] = { x: 0.43, y: 0.4 + open };
  points[468] = { x: 0.43 + irisDx, y: 0.4 + irisDy };
  // Subject's left eye (image right): inner 362, outer 263.
  points[362] = { x: 0.54, y: 0.4 };
  points[263] = { x: 0.6, y: 0.4 };
  points[386] = { x: 0.57, y: 0.4 - open };
  points[374] = { x: 0.57, y: 0.4 + open };
  points[473] = { x: 0.57 + irisDx, y: 0.4 + irisDy };
  return points;
}
const blends = (values: Record<string, number>) =>
  Object.entries(values).map(([categoryName, score]) => ({ categoryName, score }));

describe('iris geometry', () => {
  it('reads a centred iris as zero', () => {
    const eye = extractEyeFeatures(mesh(), [])!;
    expect(eye.irisH).toBeCloseTo(0, 5);
    expect(eye.irisV).toBeCloseTo(0, 5);
    const offset = eyeOffsetDegrees(eye)!;
    expect(offset.yaw).toBeCloseTo(0, 5);
    expect(offset.pitch).toBeCloseTo(0, 5);
  });
  it('maps iris moved toward image right to positive yaw', () => {
    const eye = extractEyeFeatures(mesh(0.015, 0), [])!;
    expect(eye.irisH).toBeCloseTo(0.5, 5);
    expect(eyeOffsetDegrees(eye)!.yaw).toBeCloseTo(27.5, 3);
    expect(eyeOffsetDegrees(extractEyeFeatures(mesh(-0.015, 0), [])!)!.yaw).toBeCloseTo(-27.5, 3);
  });
  it('maps an iris above the lid midline to positive pitch and below to negative', () => {
    const up = eyeOffsetDegrees(extractEyeFeatures(mesh(0, -0.0075), [])!)!;
    const down = eyeOffsetDegrees(extractEyeFeatures(mesh(0, 0.0075), [])!)!;
    expect(up.pitch).toBeCloseTo(15, 3);
    expect(down.pitch).toBeCloseTo(-15, 3);
  });
  it('is unaffected by head roll (eye axis rotation)', () => {
    const rotate = (p: Landmark, a: number): Landmark => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      return {
        x: 0.5 + (p.x - 0.5) * c - (p.y - 0.5) * s,
        y: 0.5 + (p.x - 0.5) * s + (p.y - 0.5) * c,
      };
    };
    const rolled = mesh(0.009, 0).map((p) => rotate(p, 0.4));
    expect(extractEyeFeatures(rolled, [])!.irisH).toBeCloseTo(0.3, 3);
  });
  it('treats a closed eye as unreadable rather than as a gaze', () => {
    expect(extractEyeFeatures(mesh(0, 0, 0.002), [])).toBeNull();
  });
  it('returns null without a mesh or blendshapes', () => {
    expect(extractEyeFeatures(undefined, undefined)).toBeNull();
    expect(extractEyeFeatures(mesh().slice(0, 400), [])).toBeNull();
  });
});

describe('blendshapes', () => {
  const lookRight = blends({
    eyeLookInRight: 0.5,
    eyeLookOutRight: 0,
    eyeLookInLeft: 0,
    eyeLookOutLeft: 0.5,
    eyeLookUpLeft: 0,
    eyeLookUpRight: 0,
    eyeLookDownLeft: 0,
    eyeLookDownRight: 0,
  });
  it('derives horizontal and vertical signals', () => {
    const eye = extractEyeFeatures(undefined, lookRight)!;
    expect(eye.blendH).toBeCloseTo(0.5);
    expect(eye.blendV).toBeCloseTo(0);
    expect(eyeOffsetDegrees(eye)!.yaw).toBeCloseTo(14);
    const down = extractEyeFeatures(
      undefined,
      blends({
        ...Object.fromEntries(lookRight.map((c) => [c.categoryName, 0])),
        eyeLookDownLeft: 0.6,
        eyeLookDownRight: 0.6,
      }),
    )!;
    expect(eyeOffsetDegrees(down)!.pitch).toBeCloseTo(-15);
  });
  it('blends iris and blendshape sources and can flip a mis-named blendshape side', () => {
    const eye = extractEyeFeatures(mesh(0.015, 0), lookRight)!;
    expect(eyeOffsetDegrees(eye)!.yaw).toBeCloseTo((27.5 + 14) / 2, 3);
    expect(eyeOffsetDegrees(eye, -1)!.yaw).toBeCloseTo((27.5 - 14) / 2, 3);
  });
  it('ignores the eyes while blinking', () => {
    const eye = extractEyeFeatures(
      mesh(0.015, 0),
      blends({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }),
    )!;
    expect(eye.blink).toBeCloseTo(0.9);
    expect(eyeOffsetDegrees(eye)).toBeNull();
  });
  it('learns an inverted blendshape sign from disagreement with the iris', () => {
    const learner = createBlendSignLearner();
    expect(learner.sign()).toBe(1);
    for (let i = 0; i < 30; i += 1) learner.add(0.3, -0.3);
    expect(learner.sign()).toBe(-1);
    learner.reset();
    for (let i = 0; i < 30; i += 1) learner.add(0.3, 0.3);
    expect(learner.sign()).toBe(1);
  });
});

describe('compass', () => {
  it.each([
    [0, 10, 'N'],
    [10, 10, 'NE'],
    [10, 0, 'E'],
    [10, -10, 'SE'],
    [0, -10, 'S'],
    [-10, -10, 'SW'],
    [-10, 0, 'W'],
    [-10, 10, 'NW'],
  ])('yaw %s pitch %s is %s', (yaw, pitch, name) => expect(sectorOf(yaw, pitch)).toBe(name));
  it('measures bearing clockwise from up', () => {
    expect(bearingDegrees(0, 5)).toBeCloseTo(0);
    expect(bearingDegrees(5, 0)).toBeCloseTo(90);
    expect(bearingDegrees(0, -5)).toBeCloseTo(180);
    expect(bearingDegrees(-5, 0)).toBeCloseTo(270);
  });
  it('computes how far beyond the on-screen rectangle gaze lies', () => {
    const zone = zoneOf(DEFAULT_EXTENT);
    expect(offScreenDegrees(5, 3, zone)).toBe(0);
    expect(offScreenDegrees(zone.yaw, 0, zone)).toBe(0);
    expect(offScreenDegrees(zone.yaw + 10, 0, zone)).toBeCloseTo(10);
    expect(offScreenDegrees(0, -(zone.pitch + 7), zone)).toBeCloseTo(7);
  });
  it('wraps angles', () => {
    expect(wrapDegrees(190)).toBeCloseTo(-170);
    expect(wrapDegrees(-190)).toBeCloseTo(170);
  });
});

describe('calibration', () => {
  const sample = (headYaw: number, headPitch: number, eyeYaw = 0, eyePitch = 0): RawGaze =>
    rawGaze({ yaw: headYaw, pitch: headPitch }, 0, { yaw: eyeYaw, pitch: eyePitch });
  const repeat = (s: RawGaze) => [s, s, s];

  it('without calibration, gaze is head plus eyes', () => {
    const angles = applyCalibration(sample(10, -5, 6, 3), NO_CALIBRATION);
    expect(angles.yaw).toBe(16);
    expect(angles.pitch).toBe(-2);
  });
  it('centre-only removes the resting offset', () => {
    const fit = fitCalibration({ centre: repeat(sample(4, -8, 2, 1)) })!;
    expect(fit.calibration.kind).toBe('centre');
    const angles = applyCalibration(sample(4, -8, 2, 1), fit.calibration);
    expect(angles.yaw).toBeCloseTo(0);
    expect(angles.pitch).toBeCloseTo(0);
  });
  it('five points scale corners to the assumed screen extent', () => {
    const fit = fitCalibration({
      centre: repeat(sample(0, 0)),
      topLeft: repeat(sample(-6, 4)),
      topRight: repeat(sample(6, 4)),
      bottomLeft: repeat(sample(-6, -4)),
      bottomRight: repeat(sample(6, -4)),
    })!;
    expect(fit.calibration.kind).toBe('five-point');
    expect(fit.calibration.gain.yaw).toBeCloseTo(3); // clamped from 18/6
    expect(fit.calibration.gain.pitch).toBeCloseTo(2.75);
    const tr = applyCalibration(sample(6, 4), fit.calibration);
    expect(tr.yaw).toBeCloseTo(18);
    expect(tr.pitch).toBeCloseTo(11);
  });
  it('uses head and eyes together and corrects an inverted axis sign', () => {
    const fit = fitCalibration({
      centre: repeat(sample(0, 0)),
      topLeft: repeat(sample(4, -3, 5, -2)),
      topRight: repeat(sample(-4, -3, -5, -2)),
      bottomLeft: repeat(sample(4, 3, 5, 2)),
      bottomRight: repeat(sample(-4, 3, -5, 2)),
    })!;
    expect(fit.calibration.gain.yaw).toBeLessThan(0);
    expect(fit.calibration.gain.pitch).toBeLessThan(0);
    const tr = applyCalibration(sample(-4, -3, -5, -2), fit.calibration);
    expect(tr.yaw).toBeGreaterThan(0);
    expect(tr.pitch).toBeGreaterThan(0);
  });
  it('keeps default scale and warns when nothing moved, and needs a centre', () => {
    const still = repeat(sample(0, 0));
    const fit = fitCalibration({
      centre: still,
      topLeft: still,
      topRight: still,
      bottomLeft: still,
    })!;
    expect(fit.calibration.gain).toEqual({ yaw: 1, pitch: 1 });
    expect(fit.warnings.length).toBe(2);
    expect(fitCalibration({ topLeft: still })).toBeNull();
    expect(fitCalibration({ centre: [sample(0, 0)] })).toBeNull();
  });
  it('falls back to centre-only with a warning when too few corners were read', () => {
    const fit = fitCalibration({ centre: repeat(sample(1, 1)), topLeft: repeat(sample(-6, 4)) })!;
    expect(fit.calibration.kind).toBe('centre');
    expect(fit.warnings).toHaveLength(1);
  });
});

describe('smoothing and misc', () => {
  it('one-euro passes constants and damps a single-frame spike', () => {
    const f = createOneEuro();
    let out = 0;
    for (let t = 0; t < 2000; t += 300) out = f.filter(10, t);
    expect(out).toBeCloseTo(10);
    const spike = f.filter(40, 2400);
    expect(spike).toBeLessThan(40);
    expect(spike).toBeGreaterThan(10);
  });
  it('one-euro follows a sustained move', () => {
    const f = createOneEuro();
    f.filter(0, 0);
    let out = 0;
    for (let t = 300; t <= 3000; t += 300) out = f.filter(30, t);
    expect(out).toBeGreaterThan(28);
  });
  it('reads roll and rejects bad matrices', () => {
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const m = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(rollFromMatrix(m)).toBeCloseTo((0.3 * 180) / Math.PI, 3);
    expect(rollFromMatrix([1, 2])).toBeNull();
  });
  it('derives a face box and a bounded quality score', () => {
    const box = faceBoxFromLandmarks(mesh())!;
    expect(box.w).toBeGreaterThan(0);
    expect(faceBoxFromLandmarks([])).toBeNull();
    const good = trackingQuality({
      box: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
      hasIris: true,
      poseOk: true,
      blink: 0,
    });
    expect(good).toBeCloseTo(1);
    expect(trackingQuality({ box: null, hasIris: true, poseOk: true, blink: 0 })).toBe(0);
    expect(
      trackingQuality({
        box: { x: 0.3, y: 0.2, w: 0.4, h: 0.5 },
        hasIris: true,
        poseOk: true,
        blink: 0.9,
      }),
    ).toBeLessThan(good);
  });
});
