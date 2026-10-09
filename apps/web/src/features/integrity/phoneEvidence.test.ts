import { describe, expect, it } from 'vitest';
import { createPhoneEvidence, overlapFraction } from './phoneEvidence.js';

const feed = (
  e: ReturnType<typeof createPhoneEvidence>,
  scores: Array<number | null>,
  start = 0,
) => {
  let out = e.sample({ score: null, fresh: false, now: start });
  scores.forEach((score, i) => {
    out = e.sample({ score, fresh: true, now: start + (i + 1) * 1000 });
  });
  return out;
};

describe('phone temporal confirmation', () => {
  it('starts with nothing', () => {
    expect(createPhoneEvidence().sample({ score: null, fresh: false, now: 0 }).state).toBe('none');
  });
  it('treats a single weak frame as a candidate only', () => {
    const out = feed(createPhoneEvidence(), [0.45]);
    expect(out.state).toBe('candidate');
    expect(out.lastScore).toBe(0.45);
  });
  it('confirms a single strong frame at >= 0.75', () => {
    expect(feed(createPhoneEvidence(), [0.75]).state).toBe('confirmed');
    expect(feed(createPhoneEvidence(), [0.74]).state).toBe('candidate');
  });
  it('confirms 3 of the last 5 frames at >= 0.5', () => {
    expect(feed(createPhoneEvidence(), [0.55, null, 0.6, null, 0.5]).state).toBe('confirmed');
    expect(feed(createPhoneEvidence(), [0.55, null, 0.6, null, 0.45]).state).toBe('candidate');
  });
  it('does not confirm when the hits are older than the 5-frame window', () => {
    const e = createPhoneEvidence();
    const out = feed(e, [0.55, 0.6, 0.5, null, null, null, null]);
    expect(out.windowHits).toBeLessThan(3);
    expect(out.state).not.toBe('confirmed');
  });
  it('ignores repeated cached results (fresh: false)', () => {
    const e = createPhoneEvidence();
    e.sample({ score: 0.6, fresh: true, now: 1000 });
    for (let i = 1; i < 10; i += 1) e.sample({ score: 0.6, fresh: false, now: 1000 + i * 100 });
    expect(e.sample({ score: 0.6, fresh: false, now: 2100 }).state).toBe('candidate');
  });
  it('lets old evidence expire', () => {
    const e = createPhoneEvidence();
    e.sample({ score: 0.9, fresh: true, now: 0 });
    expect(e.sample({ score: null, fresh: true, now: 11_000 }).state).toBe('none');
  });
  it('tracks counters and clears the window on stale vision but keeps lifetime stats', () => {
    const e = createPhoneEvidence();
    feed(e, [0.8, 0.45]);
    e.clear();
    const out = e.sample({ score: null, fresh: false, now: 5000 });
    expect(out.state).toBe('none');
    expect(out.maxScore).toBe(0.8);
    expect(out.candidateFrames).toBe(2);
    expect(out.confirmations).toBe(1);
  });
  it('reports the box and flags face overlap without suppressing the detection', () => {
    const e = createPhoneEvidence();
    const face = { x: 0.3, y: 0.2, w: 0.3, h: 0.4 };
    const out = e.sample({
      score: 0.8,
      fresh: true,
      now: 0,
      box: { x: 0.35, y: 0.3, w: 0.1, h: 0.15 },
      faceBox: face,
    });
    expect(out.state).toBe('confirmed');
    expect(out.overlapsFace).toBe(true);
    expect(out.box).not.toBeNull();
    const apart = createPhoneEvidence().sample({
      score: 0.8,
      fresh: true,
      now: 0,
      box: { x: 0.8, y: 0.7, w: 0.1, h: 0.2 },
      faceBox: face,
    });
    expect(apart.overlapsFace).toBe(false);
  });
  it('computes overlap fractions', () => {
    expect(overlapFraction({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0, w: 1, h: 1 })).toBeCloseTo(
      0.5,
    );
    expect(overlapFraction({ x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 2, w: 1, h: 1 })).toBe(0);
  });
});
