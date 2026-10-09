import { describe, expect, it } from 'vitest';
import {
  analyseLighting,
  isPoorLighting,
  lightingEventName,
  lightingImprovement,
  type LightingClass,
} from './lightingAnalysis.js';

const W = 64;
const H = 64;
const FACE = { x: 0.35, y: 0.25, w: 0.3, h: 0.4 };

/** Synthetic 64x64 frame: `bg` everywhere, `face` (or left/right) inside the face box. */
function frame(bg: number, face: number | [number, number], noise = 0, seed = 1): Float32Array {
  const out = new Float32Array(W * H);
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  const x0 = Math.floor(FACE.x * W);
  const x1 = Math.ceil((FACE.x + FACE.w) * W);
  const y0 = Math.floor(FACE.y * H);
  const y1 = Math.ceil((FACE.y + FACE.h) * H);
  const mid = Math.floor((x0 + x1) / 2);
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      let v = bg;
      if (x >= x0 && x < x1 && y >= y0 && y < y1)
        v = typeof face === 'number' ? face : x < mid ? face[0] : face[1];
      out[y * W + x] = Math.min(255, Math.max(0, v + rand() * noise));
    }
  return out;
}

const classify = (bg: number, face: number | [number, number], noise = 0): LightingClass =>
  analyseLighting({ frames: [frame(bg, face, noise)], faceBox: FACE })!.class;

describe('lighting classification', () => {
  it('is good for an evenly lit face with a normal background', () => {
    expect(classify(120, 140)).toBe('good');
  });
  it('is dim for a moderately dark face', () => {
    expect(classify(70, 65)).toBe('dim');
  });
  it('is too dark for a very dark face with a dark room', () => {
    expect(classify(25, 30)).toBe('too_dark');
  });
  it('is backlit when the background is bright and the face is dark', () => {
    const report = analyseLighting({ frames: [frame(220, 70)], faceBox: FACE })!;
    expect(report.class).toBe('backlit');
    expect(report.metrics.contrast).toBeGreaterThan(100);
    expect(report.tips.join(' ')).toMatch(/window/i);
  });
  it('is overexposed when the face is washed out or clipped', () => {
    expect(classify(200, 252)).toBe('overexposed');
  });
  it('is uneven when one side of the face is much brighter', () => {
    const report = analyseLighting({ frames: [frame(110, [180, 80])], faceBox: FACE })!;
    expect(report.class).toBe('uneven');
    expect(report.metrics.brighterSide).toBe('left');
    expect(report.tips.join(' ')).toMatch(/in front, not to the side/);
  });
  it('is evaluated on the picture centre when no face box is known', () => {
    const report = analyseLighting({ frames: [frame(100, 30)] })!;
    expect(report.metrics.faceKnown).toBe(false);
    expect(report.metrics.asymmetry).toBeNull();
  });
  it('returns null without a usable frame', () => {
    expect(analyseLighting({ frames: [] })).toBeNull();
    expect(analyseLighting({ frames: [new Float32Array(10)] })).toBeNull();
  });
});

describe('lighting metrics', () => {
  it('measures clipped and crushed percentages', () => {
    const report = analyseLighting({ frames: [frame(5, 255)], faceBox: FACE })!;
    expect(report.metrics.clippedPct).toBeGreaterThan(99);
    expect(report.metrics.crushedPct).toBeGreaterThan(80);
  });
  it('estimates temporal noise from consecutive frames and suggests more light when grainy', () => {
    const noisy = analyseLighting({
      frames: [frame(60, 60, 40, 1), frame(60, 60, 40, 2), frame(60, 60, 40, 3)],
      faceBox: FACE,
    })!;
    const clean = analyseLighting({ frames: [frame(60, 60), frame(60, 60)], faceBox: FACE })!;
    expect(noisy.metrics.noise).toBeGreaterThan(6);
    expect(clean.metrics.noise).toBe(0);
    expect(noisy.tips.join(' ')).toMatch(/grainy/);
  });
  it('reports a positive improvement when the face gets brighter', () => {
    const before = analyseLighting({ frames: [frame(40, 40)], faceBox: FACE })!;
    const after = analyseLighting({ frames: [frame(60, 95)], faceBox: FACE })!;
    expect(lightingImprovement(before, after)).toBeCloseTo(55, 0);
  });
});

describe('lighting helpers', () => {
  it('only warns about dark and backlit faces in the exam', () => {
    expect(isPoorLighting('too_dark')).toBe(true);
    expect(isPoorLighting('backlit')).toBe(true);
    for (const c of ['good', 'dim', 'uneven', 'overexposed'] as const)
      expect(isPoorLighting(c)).toBe(false);
  });
  it('builds the timeline event name', () => {
    expect(lightingEventName('backlit')).toBe('lighting_poor_backlit');
  });
});
