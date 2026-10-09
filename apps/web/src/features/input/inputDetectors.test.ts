import { describe, expect, it } from 'vitest';

import {
  INPUT_THRESHOLDS,
  createBurstAfterIdleDetector,
  createDriftTracker,
  createInjectionDetector,
  createPointerMotionAnalyzer,
  createPointerOutsideTracker,
  createTypingAnalyzer,
  looksSynthetic,
  nearestEdge,
  profileFromSums,
  type PointerSample,
} from './inputDetectors.js';

/** A deterministic pseudo-random generator so "human" jitter is reproducible. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function humanPath(random: () => number, startT = 0): PointerSample[] {
  const out: PointerSample[] = [];
  let x = 100;
  let y = 100;
  let t = startT;
  for (let i = 0; i < 60; i++) {
    t += 8 + random() * 20;
    x += 4 + random() * 12;
    y += (random() - 0.4) * 14;
    out.push({ t, x, y, trusted: true });
  }
  return out;
}

describe('pointer motion', () => {
  it('does not flag human-looking movement', () => {
    const analyzer = createPointerMotionAnalyzer();
    const random = rng(7);
    for (let i = 0; i < 4; i++) {
      for (const s of humanPath(random, i * 3000)) analyzer.push(s);
    }
    const stats = analyzer.drain();
    expect(stats.roboticSegments).toBe(0);
    expect(stats.teleports).toBe(0);
    expect(stats.untrusted).toBe(0);
    expect(stats.straightness).toBeLessThan(0.99);
    expect(looksSynthetic(stats)).toBe(false);
  });

  it('flags perfectly straight constant-velocity segments', () => {
    const analyzer = createPointerMotionAnalyzer();
    for (let run = 0; run < 2; run++) {
      for (let i = 0; i < 40; i++) {
        analyzer.push({ t: run * 2000 + i * 16, x: 50 + i * 10, y: 200 + i * 5, trusted: true });
      }
    }
    const stats = analyzer.drain();
    expect(stats.roboticSegments).toBe(2);
    expect(stats.straightness).toBeGreaterThan(0.999);
    expect(stats.velocityCv).toBeLessThan(0.05);
    expect(looksSynthetic(stats)).toBe(true);
  });

  it('counts instantaneous teleports but not re-entry jumps', () => {
    const analyzer = createPointerMotionAnalyzer();
    let t = 0;
    for (let i = 0; i < 3; i++) {
      analyzer.push({ t: (t += 16), x: 100, y: 100, trusted: true });
      analyzer.push({ t: (t += 16), x: 900, y: 700, trusted: true }); // > 400 px in one frame
      analyzer.push({ t: (t += 16), x: 905, y: 702, trusted: true });
    }
    // Leaving and re-entering elsewhere is a legitimate jump.
    analyzer.breakSegment();
    analyzer.push({ t: (t += 16), x: 10, y: 10, trusted: true });
    analyzer.push({ t: (t += 16), x: 20, y: 12, trusted: true });
    const stats = analyzer.drain();
    expect(stats.teleports).toBe(5); // 100->900, 905->100, repeated; first re-enter excluded
    expect(looksSynthetic(stats)).toBe(true);
  });

  it('counts untrusted events and flags them once there are several', () => {
    const analyzer = createPointerMotionAnalyzer();
    for (let i = 0; i < INPUT_THRESHOLDS.syntheticUntrusted; i++) {
      analyzer.push({ t: i * 50, x: i * 3, y: 4, trusted: false });
    }
    const stats = analyzer.drain();
    expect(stats.untrusted).toBe(INPUT_THRESHOLDS.syntheticUntrusted);
    expect(looksSynthetic(stats)).toBe(true);
    expect(looksSynthetic({ untrusted: 1, teleports: 0, roboticSegments: 0 })).toBe(false);
  });

  it('resets between windows', () => {
    const analyzer = createPointerMotionAnalyzer();
    analyzer.push({ t: 0, x: 0, y: 0, trusted: false });
    analyzer.drain();
    expect(analyzer.drain().events).toBe(0);
  });
});

describe('pointer outside the window', () => {
  it('fires once after 5 s outside while the window stays focused', () => {
    const tracker = createPointerOutsideTracker();
    tracker.leave(1000, 'right');
    expect(tracker.check(5000, true)).toBe(false);
    expect(tracker.check(6100, true)).toBe(true);
    expect(tracker.check(9000, true)).toBe(false);
  });

  it('does not fire when the window itself lost focus', () => {
    const tracker = createPointerOutsideTracker();
    tracker.leave(0, 'left');
    expect(tracker.check(20_000, false)).toBe(false);
  });

  it('aggregates count, total and longest time, with the nearest edge', () => {
    const tracker = createPointerOutsideTracker();
    tracker.leave(1000, 'left');
    tracker.enter(3000);
    tracker.leave(10_000, 'right');
    tracker.enter(17_000);
    expect(tracker.drain(20_000)).toEqual({
      leaves: 2,
      outsideMs: 9000,
      longestMs: 7000,
      edge: 'right',
    });
  });

  it('splits an excursion that spans two windows', () => {
    const tracker = createPointerOutsideTracker();
    tracker.leave(0, 'top');
    expect(tracker.drain(20_000)).toMatchObject({ leaves: 1, outsideMs: 20_000 });
    tracker.enter(30_000);
    expect(tracker.drain(40_000)).toMatchObject({ leaves: 0, outsideMs: 10_000 });
  });

  it('finds the nearest viewport edge', () => {
    expect(nearestEdge(1, 300, 1000, 800)).toBe('left');
    expect(nearestEdge(999, 300, 1000, 800)).toBe('right');
    expect(nearestEdge(500, 2, 1000, 800)).toBe('top');
    expect(nearestEdge(500, 799, 1000, 800)).toBe('bottom');
  });
});

describe('text injection', () => {
  it('flags 30+ characters appearing with fewer keydowns', () => {
    const detector = createInjectionDetector();
    detector.keyDown(1000);
    expect(detector.insert(1010, 120, false)).toBe(true);
  });

  it('flags an autotyper that inserts characters with no keydowns', () => {
    const detector = createInjectionDetector();
    let flagged = false;
    for (let i = 0; i < 40; i++) flagged = detector.insert(1000 + i * 5, 1, false) || flagged;
    expect(flagged).toBe(true);
  });

  it('does not flag ordinary typing', () => {
    const detector = createInjectionDetector();
    let flagged = false;
    for (let i = 0; i < 200; i++) {
      detector.keyDown(i * 90);
      flagged = detector.insert(i * 90 + 5, 1, false) || flagged;
    }
    expect(flagged).toBe(false);
  });

  it('ignores IME composition however much text it commits', () => {
    const detector = createInjectionDetector();
    expect(detector.insert(1000, 80, true)).toBe(false);
  });

  it('does not flag a short insertion', () => {
    const detector = createInjectionDetector();
    expect(detector.insert(1000, INPUT_THRESHOLDS.injectionChars - 1, false)).toBe(false);
  });
});

describe('typing rhythm', () => {
  const type = (
    analyzer: ReturnType<typeof createTypingAnalyzer>,
    count: number,
    next: (i: number) => number,
    dwell = (i: number) => 80 + (i % 5) * 7,
    startAt = 0,
  ) => {
    let t = startAt;
    for (let i = 0; i < count; i++) {
      t += next(i);
      analyzer.record(t, dwell(i), 'char');
    }
    return t;
  };

  it('flags scripted typing with near-constant intervals', () => {
    const analyzer = createTypingAnalyzer();
    type(analyzer, 60, () => 120);
    expect(analyzer.drain().uniformRhythm).toBe(true);
  });

  it('does not flag a human rhythm', () => {
    const analyzer = createTypingAnalyzer();
    const random = rng(3);
    type(analyzer, 120, () => 90 + random() * 220);
    const stats = analyzer.drain();
    expect(stats.uniformRhythm).toBe(false);
    expect(stats.intervalCv).toBeGreaterThan(0.2);
  });

  it('needs enough keys before judging uniformity', () => {
    const analyzer = createTypingAnalyzer();
    type(analyzer, INPUT_THRESHOLDS.uniformMinKeys - 5, () => 120);
    expect(analyzer.drain().uniformRhythm).toBe(false);
  });

  it('flags sustained speed above 150 wpm only after consecutive windows', () => {
    const analyzer = createTypingAnalyzer();
    const random = rng(5);
    // ~13.3 chars/s = 160 wpm with natural jitter
    const fast = (start: number) => type(analyzer, 200, () => 60 + random() * 30, undefined, start);
    const end = fast(0);
    expect(analyzer.drain()).toMatchObject({ sustainedFast: false });
    analyzer.breakRun();
    fast(end + 5000);
    const second = analyzer.drain();
    expect(second.wpm).toBeGreaterThan(INPUT_THRESHOLDS.fastWpm);
    expect(second.sustainedFast).toBe(true);
  });

  it('reports the correction ratio inputs and excludes pauses from rhythm', () => {
    const analyzer = createTypingAnalyzer();
    analyzer.record(0, 80, 'char');
    analyzer.record(150, 80, 'char');
    analyzer.record(300, 80, 'correction');
    analyzer.record(20_000, 80, 'char'); // a pause is not an interval
    const stats = analyzer.drain();
    expect(stats).toMatchObject({ keys: 4, chars: 3, corrections: 1, meanIntervalMs: 150 });
  });
});

describe('burst after idle', () => {
  it('flags a fast long burst after more than 60 s of nothing with focus kept', () => {
    const detector = createBurstAfterIdleDetector(0);
    let flagged = false;
    for (let i = 0; i < 40; i++) flagged = detector.chars(70_000 + i * 100, 4) || flagged;
    expect(flagged).toBe(true);
  });

  it('does not flag a short pause or slow typing after a long one', () => {
    const quick = createBurstAfterIdleDetector(0);
    let flagged = false;
    for (let i = 0; i < 40; i++) flagged = quick.chars(30_000 + i * 100, 4) || flagged;
    expect(flagged).toBe(false);

    const slow = createBurstAfterIdleDetector(0);
    for (let i = 0; i < 40; i++) flagged = slow.chars(70_000 + i * 2000, 4) || flagged;
    expect(flagged).toBe(false);
  });

  it('does not count idle time during which focus was lost', () => {
    const detector = createBurstAfterIdleDetector(0);
    detector.focusBroken();
    let flagged = false;
    for (let i = 0; i < 40; i++) flagged = detector.chars(90_000 + i * 100, 4) || flagged;
    expect(flagged).toBe(false);
  });

  it('counts pointer activity as not idle', () => {
    const detector = createBurstAfterIdleDetector(0);
    detector.activity(65_000);
    let flagged = false;
    for (let i = 0; i < 40; i++) flagged = detector.chars(70_000 + i * 100, 4) || flagged;
    expect(flagged).toBe(false);
  });
});

describe('typing baseline drift', () => {
  const sums = (n: number, dwell: number, interval: number, spread: number) => ({
    n,
    sumDwell: n * dwell,
    sumDwellSq: n * (dwell ** 2 + spread ** 2),
    nInterval: n,
    sumInterval: n * interval,
    sumIntervalSq: n * (interval ** 2 + (spread * 2) ** 2),
  });

  it('needs enough keys for a profile', () => {
    expect(profileFromSums(sums(10, 90, 180, 20))).toBeNull();
    expect(profileFromSums(sums(100, 90, 180, 20))).not.toBeNull();
  });

  it('learns from the first two minutes, then stays quiet for the same typist', () => {
    const tracker = createDriftTracker(null);
    for (let i = 0; i < 6; i++) tracker.observe(sums(60, 90, 180, 20), 20_000);
    expect(tracker.profile).not.toBeNull();
    const same = tracker.observe(sums(60, 92, 184, 20), 20_000);
    expect(same.notice).toBe(false);
    expect(Math.abs(same.drift!.zDwell)).toBeLessThan(2);
  });

  it('prefers a setup baseline and notices a strong, repeated shift', () => {
    const profile = profileFromSums(sums(120, 90, 180, 20))!;
    const tracker = createDriftTracker(profile);
    const shifted = sums(60, 140, 300, 20);
    expect(tracker.observe(shifted, 20_000)).toMatchObject({ notice: false });
    const second = tracker.observe(shifted, 20_000);
    expect(second.notice).toBe(true);
    expect(Math.abs(second.drift!.zDwell)).toBeGreaterThan(INPUT_THRESHOLDS.driftZ);
  });

  it('ignores windows with too few keys', () => {
    const tracker = createDriftTracker(profileFromSums(sums(120, 90, 180, 20))!);
    expect(tracker.observe(sums(10, 300, 900, 20), 20_000).drift).toBeNull();
  });
});
