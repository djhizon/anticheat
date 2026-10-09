import { describe, expect, it, vi } from 'vitest';
import { createEyeGazeTracker } from './eyeGazeTracker.js';
import { createPhoneEvidence } from './phoneEvidence.js';
import type { VisionObservation, VisionSample } from './visionSignals.js';

const evidence = createPhoneEvidence().sample({ score: null, fresh: false, now: 0 });
function sample(
  at: number,
  over: Partial<VisionObservation> = {},
  eyeYawRatio: number | null = 0,
): VisionSample {
  return {
    at,
    phoneEvidence: evidence,
    observation: {
      faces: 1,
      pose: { yaw: 0, pitch: 0 },
      phone: false,
      earbuds: null,
      smartGlasses: null,
      blinkScore: 0,
      landmarkJitter: 0,
      eye:
        eyeYawRatio === null
          ? null
          : { irisH: eyeYawRatio, irisV: 0, blendH: null, blendV: null, blink: 0 },
      quality: 0.9,
      ...over,
    },
  };
}

describe('eye gaze tracker', () => {
  it('adds eye direction to head pose and reports it through the hook', () => {
    const hook = vi.fn();
    const t = createEyeGazeTracker({ onSample: hook });
    const g = t.push(sample(0, { pose: { yaw: 10, pitch: 0 } }, 0.2))!;
    expect(g.headYaw).toBe(10);
    expect(g.eyeYaw).toBeCloseTo(11);
    expect(g.yaw).toBeCloseTo(21);
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it('returns null and no hook call without exactly one face', () => {
    const hook = vi.fn();
    const t = createEyeGazeTracker({ onSample: hook });
    expect(t.push(sample(0, { faces: 2 }))).toBeNull();
    expect(t.push(sample(300, { faces: 0, pose: null }))).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(t.snapshot().stats.multipleFaceEvents).toBe(1);
  });
  it('holds the last eye offset briefly during a blink', () => {
    const t = createEyeGazeTracker();
    t.push(sample(0, {}, 0.2));
    const g = t.push(
      sample(300, {
        blinkScore: 0.9,
        eye: { irisH: 0.2, irisV: 0, blendH: null, blendV: null, blink: 0.9 },
      }),
    )!;
    expect(g.eyesValid).toBe(false);
    expect(g.eyeYaw).toBeCloseTo(11);
    const late = t.push(sample(1500, { eye: null }, null))!;
    expect(late.eyeYaw).toBe(0);
  });
  it('centre-only calibration re-zeroes gaze', () => {
    const t = createEyeGazeTracker();
    for (let i = 0; i < 4; i += 1) t.push(sample(i * 300, { pose: { yaw: 8, pitch: -6 } }, 0));
    expect(t.calibrateCentreNow()!.calibration.kind).toBe('centre');
    const g = t.push(sample(1500, { pose: { yaw: 8, pitch: -6 } }, 0))!;
    expect(Math.abs(g.yaw)).toBeLessThan(0.5);
    expect(g.onScreen).toBe(true);
    expect(g.calibration).toBe('centre');
  });
  it('five-point capture produces a gain and marks distant gaze off screen', () => {
    const t = createEyeGazeTracker();
    let now = 0;
    const capture = (yaw: number, pitch: number) => {
      t.beginCapture();
      for (let i = 0; i < 4; i += 1) t.push(sample((now += 300), { pose: { yaw, pitch } }, 0));
      return t.endCapture();
    };
    const fit = t.applyFit({
      centre: capture(0, 0),
      topLeft: capture(-9, 5),
      topRight: capture(9, 5),
      bottomRight: capture(9, -5),
      bottomLeft: capture(-9, -5),
    })!;
    expect(fit.calibration.kind).toBe('five-point');
    expect(fit.calibration.gain.yaw).toBeCloseTo(2);
    const far = t.push(sample((now += 300), { pose: { yaw: 20, pitch: 0 } }, 0))!;
    expect(far.onScreen).toBe(false);
    expect(far.sector).toBe('E');
  });
  it('smooths a one-frame spike', () => {
    const t = createEyeGazeTracker();
    for (let i = 0; i < 5; i += 1) t.push(sample(i * 300, {}, 0));
    const g = t.push(sample(1500, { pose: { yaw: 40, pitch: 0 } }, 0))!;
    expect(g.yaw).toBeLessThan(40);
    expect(g.headYaw).toBe(40);
  });
  it('keeps a 5 s trail', () => {
    const t = createEyeGazeTracker();
    for (let i = 0; i < 40; i += 1) t.push(sample(i * 300, {}, 0));
    const { trail } = t.snapshot();
    expect(trail[trail.length - 1]!.t - trail[0]!.t).toBeLessThanOrEqual(5000);
    expect(trail.length).toBeGreaterThan(10);
  });
});
