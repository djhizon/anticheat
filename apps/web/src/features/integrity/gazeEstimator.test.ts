import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENT,
  NO_CALIBRATION,
  applyCalibration,
  buildSample,
  bearingDegrees,
  createBlendSignLearner,
  createOneEuro,
  extractEyeFeatures,
  eyeOffsetDegrees,
  faceBoxFromLandmarks,
  offScreenDegrees,
  rawGaze,
  reporterAngles,
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

  it('without calibration, gaze is head plus eyes', () => {
    const angles = applyCalibration(sample(10, -5, 6, 3), NO_CALIBRATION);
    expect(angles.yaw).toBe(16);
    expect(angles.pitch).toBe(-2);
  });
  it('uses an explicit wider zone and carries confidence into the sample', () => {
    const cal = {
      ...NO_CALIBRATION,
      zone: { yaw: 40, pitch: 30 },
      confidence: 0.2,
    };
    const angles = applyCalibration(sample(30, -20), cal);
    const s = buildSample(0, angles, angles, cal, true, 0.9);
    expect(s.onScreen).toBe(true);
    expect(s.confidence).toBe(0.2);
    expect(s.headOnly).toBe(false);
    expect(buildSample(0, angles, angles, NO_CALIBRATION, true, 0.9).onScreen).toBe(false);
  });
  it('reports directions only when trusted or clearly off screen', () => {
    const cal = { ...NO_CALIBRATION, zone: { yaw: 40, pitch: 30 }, confidence: 0.2 };
    const near = applyCalibration(sample(30, 0), cal);
    expect(reporterAngles(buildSample(0, near, near, cal, true, 1))).toEqual({ yaw: 0, pitch: 0 });
    const far = applyCalibration(sample(60, 0), cal);
    expect(reporterAngles(buildSample(0, far, far, cal, true, 1)).yaw).toBe(60);
    const trusted = { ...cal, confidence: 0.8 };
    expect(reporterAngles(buildSample(0, near, near, trusted, true, 1)).yaw).toBe(30);
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
