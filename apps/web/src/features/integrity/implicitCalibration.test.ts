import { describe, expect, it } from 'vitest';
import { cameraTriggers } from '../evidence/evidenceCapture.js';
import { emptyCamera } from './cameraSession.js';
import { createEyeGazeTracker, type EyeGazeTracker } from './eyeGazeTracker.js';
import { reporterAngles, type Angles, type GazeSample } from './gazeEstimator.js';
import {
  CALIBRATED_CONFIDENCE,
  FACE_WIDTH_MM,
  POSTURE_HOLD_MS,
  axisConfidence,
  focalNorm,
  robustLine,
  screenGeometry,
  viewingDistanceMm,
} from './implicitCalibration.js';
import { createPhoneEvidence } from './phoneEvidence.js';

const SCREEN = { width: 1440, height: 900 };
const FRAME_MS = 300;
const evidence = createPhoneEvidence().sample({ score: null, fresh: false, now: 0 });
const deg = (r: number) => (r * 180) / Math.PI;

/** Deterministic PRNG (mulberry32) + Box-Muller normal noise. */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, uniform()))) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal, range: (lo: number, hi: number) => lo + (hi - lo) * uniform() };
}

/**
 * A synthetic student whose raw tracker reading has an offset and gain error relative to the
 * true angle of the screen point they look at (the camera-centre model is wrong for them).
 */
interface Student {
  offset: Angles;
  gain: Angles;
  distanceMm: number;
  noise: number;
}

function simulate(student: Student, seed = 1, tracker?: EyeGazeTracker) {
  const t = tracker ?? createEyeGazeTracker({ screen: SCREEN });
  const r = rng(seed);
  let now = 0;
  let last: GazeSample | null = null;
  /** The face box follows distance, and shifts sideways when the head turns (nose/cheek). */
  const faceBox = (headYaw: number) => {
    const w = (FACE_WIDTH_MM * focalNorm()) / student.distanceMm;
    const shift = 0.6 * w * Math.sin((headYaw * Math.PI) / 180);
    return { x: 0.5 - w / 2 + shift, y: 0.25, w, h: w * 1.2 };
  };
  /** Raw (head + eyes) reading when truly looking at screen point (u, v) or at a raw angle. */
  const rawFor = (u: number, v: number): Angles => {
    const g = screenGeometry(student.distanceMm, SCREEN);
    const yaw = deg(Math.atan((u * g.widthMm) / 2 / student.distanceMm));
    const pitch = deg(Math.atan((v * g.heightMm) / 2 / student.distanceMm));
    return {
      yaw: student.offset.yaw + student.gain.yaw * yaw,
      pitch: student.offset.pitch + student.gain.pitch * pitch,
    };
  };
  const frame = (raw: Angles, irisH = 0) => {
    now += FRAME_MS;
    const pose = {
      yaw: raw.yaw + r.normal() * student.noise,
      pitch: raw.pitch + r.normal() * student.noise,
    };
    last = t.push({
      at: now,
      phoneEvidence: evidence,
      observation: {
        faces: 1,
        pose,
        phone: false,
        earbuds: null,
        smartGlasses: null,
        blinkScore: 0,
        landmarkJitter: 0,
        eye: { irisH, irisV: 0, blendH: null, blendV: null, blink: 0 },
        faceBox: faceBox(pose.yaw),
        quality: 0.9,
      },
    });
    return last;
  };
  const api = {
    tracker: t,
    rng: r,
    now: () => now,
    rawFor,
    frame,
    /** Look at (u, v) for n frames; returns the last sample. */
    look(u: number, v: number, frames = 6): GazeSample {
      for (let i = 0; i < frames; i += 1) frame(rawFor(u, v));
      return last!;
    },
    /** Click target (u, v). `lookingAt` overrides where the eyes actually are (outliers). */
    click(u: number, v: number, lookingAt?: Angles): void {
      const raw = lookingAt ?? rawFor(u, v);
      frame(raw);
      frame(raw);
      t.observeInteraction({ kind: 'pointer', t: now + 5, point: { x: u, y: v }, precise: true });
    },
    clickRandom(n: number): void {
      for (let i = 0; i < n; i += 1) api.click(r.range(-0.9, 0.9), r.range(-0.9, 0.9));
    },
    /** Type for `ms` into a field centred at (u, v); `keyboardShare` of frames look down. */
    type(u: number, v: number, ms: number, precise: boolean, keyboardShare = 0): void {
      const end = now + ms;
      while (now < end) {
        const raw = r.uniform() < keyboardShare ? rawFor(u, -3.2) : rawFor(u, v);
        t.observeInteraction({ kind: 'typing', t: now + 1, point: { x: u, y: v }, precise });
        frame(raw);
      }
    },
    /** Mean calibrated gaze while looking at (u, v), after the smoothing settles. */
    meanLook(u: number, v: number): Angles {
      api.look(u, v, 4);
      let yaw = 0;
      let pitch = 0;
      for (let i = 0; i < 8; i += 1) {
        const g = api.look(u, v, 1);
        yaw += g.yaw / 8;
        pitch += g.pitch / 8;
      }
      return { yaw, pitch };
    },
    /** On-screen classification of a point, after the smoothing settles. */
    onScreen(u: number, v: number): boolean {
      return api.look(u, v, 8).onScreen;
    },
  };
  return api;
}

const GRID = [-0.85, 0, 0.85];
const onScreenPoints = GRID.flatMap((u) => GRID.map((v) => [u, v] as const));
const offScreenPoints = [
  [-1.9, 0],
  [1.9, 0],
  [0, -2.4], // desk / lap
  [0, 2.6], // above the screen
] as const;

const mis: Student = {
  offset: { yaw: 7, pitch: -13 },
  gain: { yaw: 1.5, pitch: 0.7 },
  distanceMm: 550,
  noise: 1.2,
};

describe('geometry prior', () => {
  it('estimates viewing distance from the inter-pupillary distance or the face width', () => {
    const f = focalNorm(65);
    expect(viewingDistanceMm({ ipd: (63 * f) / 550 })).toBeCloseTo(550, 0);
    // A turned head foreshortens the IPD; the estimate corrects for it.
    const turned = ((63 * f) / 550) * Math.cos((30 * Math.PI) / 180);
    expect(viewingDistanceMm({ ipd: turned, headYaw: 30 })).toBeCloseTo(550, 0);
    expect(viewingDistanceMm({ faceWidth: (140 * f) / 600 })).toBeCloseTo(600, 0);
    expect(viewingDistanceMm({ ipd: null, faceWidth: null })).toBeNull();
    expect(viewingDistanceMm({ ipd: 0.5 })).toBe(300); // clamped
  });
  it('turns distance and screen size into degrees, with a wider camera-centred learning zone', () => {
    const g = screenGeometry(550, SCREEN);
    expect(g.widthMm).toBe(360);
    expect(g.extent.yaw).toBeCloseTo(18.1, 1);
    expect(g.extent.pitch).toBeCloseTo(11.6, 1);
    expect(g.learningZone.yaw).toBeGreaterThan(g.extent.yaw * 1.9);
    expect(g.learningZone.pitch).toBeGreaterThan(g.extent.pitch * 2.5);
    // Farther away the screen subtends less.
    expect(screenGeometry(800, SCREEN).extent.yaw).toBeLessThan(g.extent.yaw);
  });
});

describe('robust line', () => {
  it('recovers offset and gain and rejects gross outliers', () => {
    const r = rng(3);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const x = r.range(-15, 15);
      xs.push(x);
      ys.push(i % 4 === 0 ? -45 + r.normal() * 3 : 5 + 1.4 * x + r.normal());
    }
    const fit = robustLine(xs, ys, { priorSlope: 1, minSpread: 4 })!;
    expect(fit.offset).toBeCloseTo(5, 0);
    expect(fit.slope).toBeCloseTo(1.4, 1);
    expect(fit.gainFitted).toBe(true);
    expect(fit.inliers).toBeGreaterThanOrEqual(28);
    expect(fit.inliers).toBeLessThanOrEqual(31);
  });
  it('falls back to offset-only without enough spread', () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i % 2) * 0.5);
    const ys = xs.map((x) => 3 + 2 * x);
    const fit = robustLine(xs, ys, { priorSlope: 1, minSpread: 4 })!;
    expect(fit.gainFitted).toBe(false);
    expect(fit.slope).toBe(1);
    expect(fit.offset).toBeCloseTo(3.25, 1);
    expect(axisConfidence(fit)).toBeLessThan(axisConfidence({ ...fit, gainFitted: true }));
    expect(robustLine([], [], { priorSlope: 1, minSpread: 4 })).toBeNull();
  });
  it('learns an inverted axis (mirrored camera convention)', () => {
    const xs = Array.from({ length: 20 }, (_, i) => -12 + i * 1.2);
    const fit = robustLine(
      xs,
      xs.map((x) => -1.2 * x),
      { priorSlope: 1, minSpread: 4 },
    )!;
    expect(fit.slope).toBeCloseTo(-1.2, 2);
  });
});

describe('implicit calibration with synthetic students', () => {
  it('converges to correct on-screen classification after about 20 clicks', () => {
    const s = simulate(mis, 11);
    // Before any interaction: nothing on screen is flagged despite the offset/gain error.
    for (const [u, v] of onScreenPoints) expect(s.onScreen(u, v)).toBe(true);
    expect(s.tracker.calibrationState().phase).toBe('learning');

    s.clickRandom(20);
    const state = s.tracker.calibrationState();
    expect(state.phase).toBe('calibrated');
    expect(state.confidence).toBeGreaterThanOrEqual(CALIBRATED_CONFIDENCE);
    expect(state.gainFitted).toEqual({ yaw: true, pitch: true });

    for (const [u, v] of onScreenPoints) expect(s.onScreen(u, v)).toBe(true);
    for (const [u, v] of offScreenPoints) expect(s.onScreen(u, v)).toBe(false);
    const centre = s.meanLook(0, 0);
    expect(Math.abs(centre.yaw)).toBeLessThan(2.5);
    expect(Math.abs(centre.pitch)).toBeLessThan(2.5);
  });

  it('a moderate look-away is only flagged once calibrated (wide tolerance first)', () => {
    const s = simulate(mis, 12);
    // Just beside the screen: inside the learning zone, outside the calibrated one.
    expect(s.onScreen(-1.6, 0)).toBe(true);
    s.clickRandom(20);
    expect(s.onScreen(-1.6, 0)).toBe(false);
  });

  it('is robust to outlier clicks made while looking at the keyboard', () => {
    const s = simulate(mis, 13);
    for (let i = 0; i < 36; i += 1) {
      const u = s.rng.range(-0.9, 0.9);
      const v = s.rng.range(-0.9, 0.9);
      // About 30% of clicks happen while the eyes are on the keyboard.
      if (i % 3 === 0) s.click(u, v, s.rawFor(s.rng.range(-0.5, 0.5), -3.2));
      else s.click(u, v);
    }
    expect(s.tracker.calibrationState().phase).toBe('calibrated');
    for (const [u, v] of onScreenPoints) expect(s.onScreen(u, v)).toBe(true);
    for (const [u, v] of offScreenPoints) expect(s.onScreen(u, v)).toBe(false);
    const centre = s.meanLook(0, 0);
    expect(Math.abs(centre.yaw)).toBeLessThan(2.5);
    expect(Math.abs(centre.pitch)).toBeLessThan(2.5);
  });

  it('self-centres from typing alone (median while typing), even with keyboard glances', () => {
    const s = simulate({ ...mis, gain: { yaw: 1, pitch: 1 } }, 14);
    const before = s.look(0, 0, 8);
    expect(Math.hypot(before.yaw, before.pitch)).toBeGreaterThan(10);
    // A large essay box: imprecise target, so no pairs, only self-centering.
    s.type(0, 0, 20_000, false, 0.25);
    expect(s.tracker.calibrationState().pairs).toBe(0);
    const after = s.meanLook(0, 0);
    expect(Math.abs(after.yaw)).toBeLessThan(2.5);
    expect(Math.abs(after.pitch)).toBeLessThan(3);
  });

  it('corrects slow drift while typing (laptop lid / head creeping)', () => {
    const student = { ...mis };
    const s = simulate(student, 15);
    s.clickRandom(24);
    expect(s.tracker.calibrationState().phase).toBe('calibrated');
    // 60 s of typing in a small answer field while the offset drifts by (+6, -5) degrees.
    for (let i = 0; i < 60; i += 1) {
      student.offset = { yaw: 7 + (6 * (i + 1)) / 60, pitch: -13 - (5 * (i + 1)) / 60 };
      s.type(0, -0.3, 1000, true);
    }
    for (let i = 0; i < 20; i += 1) s.type(0, -0.3, 1000, true);
    expect(s.tracker.calibrationState().postureResets).toBe(0);
    const field = s.meanLook(0, -0.3);
    const target = -0.3 * screenGeometry(550, SCREEN).extent.pitch;
    expect(Math.abs(field.yaw)).toBeLessThan(2.5);
    expect(Math.abs(field.pitch - target)).toBeLessThan(2.5);
  });

  it('detects a posture change, re-enters learning with a wide zone, then re-converges', () => {
    const student = { ...mis };
    const s = simulate(student, 16);
    s.clickRandom(20);
    expect(s.tracker.calibrationState().phase).toBe('calibrated');
    // The student leans in (face 30% larger) and the head/eye bias shifts.
    student.distanceMm = 420;
    student.offset = { yaw: 13, pitch: -21 };
    s.look(0, 0, Math.ceil(POSTURE_HOLD_MS / FRAME_MS) + 8);
    const state = s.tracker.calibrationState();
    expect(state.postureResets).toBe(1);
    expect(state.phase).toBe('learning');
    expect(state.pairs).toBe(0);
    expect(state.distanceMm).toBeLessThan(470);
    // Learning again: nobody is flagged while the model is unsettled.
    for (const [u, v] of onScreenPoints) expect(s.onScreen(u, v)).toBe(true);
    s.clickRandom(20);
    expect(s.tracker.calibrationState().phase).toBe('calibrated');
    for (const [u, v] of onScreenPoints) expect(s.onScreen(u, v)).toBe(true);
    for (const [u, v] of offScreenPoints) expect(s.onScreen(u, v)).toBe(false);
  });

  it('does not treat looking away (head turned) as a posture change', () => {
    const s = simulate(mis, 17);
    s.clickRandom(20);
    // A long look at notes far to the side: the face box shifts but the head is turned.
    s.look(-3.5, -1.5, 20);
    expect(s.tracker.calibrationState().postureResets).toBe(0);
    expect(s.tracker.calibrationState().phase).toBe('calibrated');
  });

  it('suppresses look-away events while confidence is low', () => {
    const s = simulate(
      { offset: { yaw: 9, pitch: -15 }, gain: { yaw: 1.6, pitch: 0.8 }, distanceMm: 550, noise: 1 },
      18,
    );
    const camera = { ...emptyCamera(), phase: 'live' as const, faces: 1 };
    // 30 s reading the edges and corners of the screen without clicking anything.
    for (let i = 0; i < 100; i += 1) {
      const corner = [
        [-0.95, -0.95],
        [0.95, -0.95],
        [-0.95, 0.95],
        [0.95, 0.95],
        [0, -0.95],
      ][i % 5]!;
      const sample = s.look(corner[0]!, corner[1]!, 1);
      expect(sample.onScreen).toBe(true);
      expect(cameraTriggers(camera, sample).has('look_away')).toBe(false);
      expect(reporterAngles(sample)).toEqual({ yaw: 0, pitch: 0 });
    }
    expect(s.tracker.snapshot().stats.lookAwayCount).toBe(0);
    expect(s.tracker.calibrationState().confidence).toBe(0);
    // A real, large look-away is still seen even before calibration.
    const away = s.look(-4, 0, 8);
    expect(away.onScreen).toBe(false);
    expect(cameraTriggers(camera, away).has('look_away')).toBe(true);
  });

  it('falls back to head pose only when the iris readings are unstable', () => {
    const s = simulate(mis, 19);
    let last: GazeSample | null = null;
    for (let i = 0; i < 12; i += 1) last = s.frame(s.rawFor(0, 0), i % 2 === 0 ? 0.5 : -0.5);
    expect(last!.headOnly).toBe(true);
    expect(last!.eyeYaw).toBe(0);
    expect(s.tracker.calibrationState().headOnly).toBe(true);
    expect(s.tracker.calibrationState().confidence).toBeLessThan(CALIBRATED_CONFIDENCE);
    const wide = last!.zone.yaw;
    // Stable eyes again: back to the eye model with a tighter zone.
    for (let i = 0; i < 12; i += 1) last = s.frame(s.rawFor(0, 0), 0);
    expect(last!.headOnly).toBe(false);
    expect(last!.zone.yaw).toBeLessThan(wide);
  });
});
