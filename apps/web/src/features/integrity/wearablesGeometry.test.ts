import { describe, expect, it } from 'vitest';

import {
  headGeometry,
  keypointsFromMesh,
  KEYPOINT_LANDMARKS,
  plausibleDetections,
  type FaceKeypoints,
} from './wearablesGeometry.js';

/** A frontal face in a 1280x720 frame: 200 px wide, 260 px tall, centred at (640, 360). */
const face: FaceKeypoints = {
  earLeft: { x: 540 / 1280, y: 350 / 720 },
  earRight: { x: 740 / 1280, y: 350 / 720 },
  eyeLeft: { x: 580 / 1280, y: 320 / 720 },
  eyeRight: { x: 700 / 1280, y: 320 / 720 },
  forehead: { x: 640 / 1280, y: 230 / 720 },
  chin: { x: 640 / 1280, y: 490 / 720 },
};

describe('keypointsFromMesh', () => {
  it('picks the named landmarks and rejects short or invalid meshes', () => {
    const mesh = Array.from({ length: 478 }, (_, i) => ({ x: i / 1000, y: i / 2000 }));
    const kp = keypointsFromMesh(mesh);
    expect(kp?.earLeft).toEqual({ x: KEYPOINT_LANDMARKS.earLeft / 1000, y: 234 / 2000 });
    expect(kp?.chin).toEqual({ x: 0.152, y: 0.076 });
    expect(keypointsFromMesh(mesh.slice(0, 200))).toBeNull();
    expect(keypointsFromMesh(undefined)).toBeNull();
    const broken = [...mesh];
    broken[10] = { x: Number.NaN, y: 0 };
    expect(keypointsFromMesh(broken)).toBeNull();
  });
});

describe('headGeometry', () => {
  it('builds a square (in pixels) head crop about two face widths wide, inside the frame', () => {
    const g = headGeometry(face, 1280, 720)!;
    const sidePx = g.head.w * 1280;
    expect(g.head.h * 720).toBeCloseTo(sidePx, 6);
    // max(2.1 x 200, 1.9 x 260) = 494 px.
    expect(sidePx).toBeCloseTo(494, 6);
    expect(g.head.x * 1280 + sidePx / 2).toBeCloseTo(640, 6);
    // Ears and eyes lie inside the crop.
    for (const r of [...g.ears, g.eyes]) {
      expect(r.x).toBeGreaterThanOrEqual(g.head.x);
      expect(r.x + r.w).toBeLessThanOrEqual(g.head.x + g.head.w + 1e-9);
    }
    // The ear regions sit at the face edges, extending outward.
    expect(g.ears[0].x * 1280).toBeLessThan(540);
    expect((g.ears[1].x + g.ears[1].w) * 1280).toBeGreaterThan(740);
  });

  it('shifts the crop back inside the frame near an edge and caps it at the frame', () => {
    const shifted: FaceKeypoints = Object.fromEntries(
      Object.entries(face).map(([k, p]) => [k, { x: p.x - 0.4, y: p.y }]),
    ) as unknown as FaceKeypoints;
    const g = headGeometry(shifted, 1280, 720)!;
    expect(g.head.x).toBe(0);
    const huge: FaceKeypoints = { ...face, forehead: { x: 0.5, y: 0 }, chin: { x: 0.5, y: 1 } };
    const big = headGeometry(huge, 1280, 720)!;
    expect(big.head.h).toBeCloseTo(1, 6);
    expect(big.head.y).toBe(0);
  });

  it('returns null for degenerate faces or frames', () => {
    expect(headGeometry({ ...face, earRight: face.earLeft }, 1280, 720)).toBeNull();
    expect(headGeometry(face, 0, 720)).toBeNull();
  });
});

describe('plausibleDetections', () => {
  const g = headGeometry(face, 1280, 720)!;
  const at = (cls: 'earbuds' | 'glasses' | 'headphones' | 'phone', x: number, y: number) => ({
    cls,
    score: 0.8,
    box: { x: x / 1280, y: y / 720, w: 20 / 1280, h: 20 / 720 },
  });

  it('keeps earbuds at an ear and glasses at the eyes, drops them elsewhere', () => {
    const kept = plausibleDetections(
      [
        at('earbuds', 530, 360), // at the image-left ear
        at('earbuds', 640, 600), // on the chest
        at('glasses', 620, 315), // across the eyes
        at('glasses', 100, 100), // someone else's / on the desk
        at('phone', 100, 600), // other classes are not position-filtered
      ],
      g,
    );
    expect(kept.map((d) => `${d.cls}@${Math.round(d.box.x * 1280)}`)).toEqual([
      'earbuds@530',
      'glasses@620',
      'phone@100',
    ]);
  });

  it('filters nothing without landmarks', () => {
    expect(plausibleDetections([at('earbuds', 0, 0)], null)).toHaveLength(1);
  });
});
