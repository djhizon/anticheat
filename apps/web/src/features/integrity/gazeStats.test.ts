import { describe, expect, it } from 'vitest';
import {
  SECTORS,
  buildSample,
  NO_CALIBRATION,
  applyCalibration,
  rawGaze,
} from './gazeEstimator.js';
import { createGazeStats, type StatsInput } from './gazeStats.js';

function gazeAt(t: number, yaw: number, pitch: number) {
  const angles = applyCalibration(rawGaze({ yaw, pitch }, 0, null), NO_CALIBRATION);
  return buildSample(t, angles, { yaw, pitch }, NO_CALIBRATION, true, 0.9);
}
function input(
  t: number,
  yaw: number | null,
  pitch = 0,
  extra: Partial<StatsInput> = {},
): StatsInput {
  return {
    t,
    faces: yaw === null ? 0 : 1,
    gaze: yaw === null ? null : gazeAt(t, yaw, pitch),
    blink: 0,
    quality: 0.8,
    phone: null,
    phoneAvailable: true,
    ...extra,
  };
}

describe('gaze statistics', () => {
  it('computes time on screen and per-sector dwell', () => {
    const s = createGazeStats();
    for (let i = 0; i <= 10; i += 1) s.add(input(i * 500, 0)); // 5 s on screen
    for (let i = 11; i <= 20; i += 1) s.add(input(i * 500, 0, -40)); // looking down
    const snap = s.snapshot();
    expect(snap.onScreenPct).toBeGreaterThan(50);
    expect(snap.sectorMs[SECTORS.indexOf('S')]).toBeGreaterThan(4000);
    expect(snap.sectorMs[SECTORS.indexOf('N')]).toBe(0);
    expect(snap.facePresentPct).toBe(100);
  });

  it('counts a look-away only after 1 s and measures longest and average', () => {
    const s = createGazeStats();
    let t = 0;
    const run = (n: number, yaw: number) => {
      for (let i = 0; i < n; i += 1) {
        s.add(input(t, yaw));
        t += 500;
      }
    };
    run(4, 0);
    run(1, 40); // 0.5 s glance: not counted
    run(4, 0);
    expect(s.snapshot().lookAwayCount).toBe(0);
    run(6, 40); // about 3 s
    run(4, 0);
    run(5, 40); // about 2 s
    run(4, 0);
    const snap = s.snapshot();
    expect(snap.lookAwayCount).toBe(2);
    expect(snap.longestLookAwayMs).toBeGreaterThanOrEqual(2500);
    expect(snap.longestLookAwayMs).toBeLessThan(3500);
    expect(snap.averageLookAwayMs).toBeGreaterThan(2000);
    expect(snap.currentLookAwayMs).toBe(0);
  });

  it('does not split one look-away on a single on-screen blip', () => {
    const s = createGazeStats();
    let t = 0;
    for (const yaw of [0, 40, 40, 40, 0, 40, 40, 40, 0, 0, 0, 0]) {
      s.add(input(t, yaw));
      t += 400;
    }
    expect(s.snapshot().lookAwayCount).toBe(1);
  });

  it('does not count a missing face as a look-away and reports face presence', () => {
    const s = createGazeStats();
    for (let i = 0; i < 6; i += 1) s.add(input(i * 500, 0));
    for (let i = 6; i < 12; i += 1) s.add(input(i * 500, null));
    const snap = s.snapshot();
    expect(snap.lookAwayCount).toBe(0);
    expect(snap.facePresentPct).toBeGreaterThan(40);
    expect(snap.facePresentPct).toBeLessThan(60);
    expect(snap.quality).toBeNull();
  });

  it('counts multiple-face events by rising edge', () => {
    const s = createGazeStats();
    const seq = [1, 2, 2, 1, 2, 1];
    seq.forEach((faces, i) => s.add(input(i * 500, 0, 0, { faces })));
    expect(s.snapshot().multipleFaceEvents).toBe(2);
  });

  it('computes blink rate from hysteresis edges after 10 s', () => {
    const s = createGazeStats();
    let t = 0;
    for (let i = 0; i < 40; i += 1) {
      const blink = i % 8 === 3 ? 0.9 : 0.05;
      s.add(input(t, 0, 0, { blink }));
      t += 500;
    }
    const snap = s.snapshot();
    expect(snap.blinkCount).toBe(5);
    expect(snap.blinkRatePerMin).toBeGreaterThan(10);
    const early = createGazeStats();
    early.add(input(0, 0, 0, { blink: 0.9 }));
    expect(early.snapshot().blinkRatePerMin).toBeNull();
  });

  it('smooths vision fps and ignores long gaps', () => {
    const s = createGazeStats();
    for (let i = 0; i < 10; i += 1) s.add(input(i * 250, 0));
    expect(s.snapshot().fps).toBeCloseTo(4, 1);
    s.add(input(60_000, 0));
    expect(s.snapshot().observedMs).toBeLessThan(3000);
  });

  it('carries phone evidence and resets', () => {
    const s = createGazeStats();
    s.add(
      input(0, 0, 0, {
        phone: {
          state: 'confirmed',
          best: 0.8,
          lastScore: 0.8,
          maxScore: 0.9,
          candidateFrames: 3,
          confirmations: 1,
          box: null,
          overlapsFace: false,
          windowHits: 3,
        },
      }),
    );
    const snap = s.snapshot();
    expect(snap.phoneMaxScore).toBe(0.9);
    expect(snap.phoneConfirmations).toBe(1);
    expect(snap.phoneState).toBe('confirmed');
    s.reset();
    expect(s.snapshot().phoneCandidateFrames).toBe(0);
    expect(s.snapshot().observedMs).toBe(0);
  });
});
