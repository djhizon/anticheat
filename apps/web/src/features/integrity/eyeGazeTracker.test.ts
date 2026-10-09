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
  it('starts uncalibrated-but-wide: a camera-centre model with no prompt and no early flags', () => {
    const t = createEyeGazeTracker({ screen: { width: 1440, height: 900 } });
    const g = t.push(sample(0, { pose: { yaw: 25, pitch: -20 } }, 0))!;
    expect(g.calibration).toBe('auto');
    expect(g.confidence).toBe(0);
    expect(g.onScreen).toBe(true);
    expect(t.calibrationState().phase).toBe('learning');
  });
  it('learns the screen centre from clicks and re-zeroes gaze', () => {
    const t = createEyeGazeTracker({ screen: { width: 1440, height: 900 } });
    let now = 0;
    for (let i = 0; i < 16; i += 1) {
      t.push(sample((now += 300), { pose: { yaw: 8, pitch: -6 } }, 0));
      t.observeInteraction({ kind: 'pointer', t: now + 10, point: { x: 0, y: 0 }, precise: true });
      now += 400;
    }
    for (let i = 0; i < 5; i += 1) t.push(sample((now += 300), { pose: { yaw: 8, pitch: -6 } }, 0));
    const g = t.latest()!;
    expect(Math.abs(g.yaw)).toBeLessThan(0.5);
    expect(Math.abs(g.pitch)).toBeLessThan(0.5);
    expect(g.onScreen).toBe(true);
    expect(t.calibrationState().pairs).toBe(16);
    expect(t.calibrationState().confidence).toBeGreaterThan(0);
  });
  it('ignores interactions with no recent face reading and non-finite points', () => {
    const t = createEyeGazeTracker();
    t.observeInteraction({ kind: 'pointer', t: 100, point: { x: 0, y: 0 }, precise: true });
    t.push(sample(5000));
    t.observeInteraction({ kind: 'pointer', t: 5010, point: { x: NaN, y: 0 }, precise: true });
    expect(t.calibrationState().pairs).toBe(0);
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
