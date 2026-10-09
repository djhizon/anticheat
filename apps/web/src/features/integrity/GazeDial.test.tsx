// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { GazeDial, dialPoint } from './GazeDial.js';
import { GazeStats } from './GazeStatsView.js';
import { createEyeGazeTracker } from './eyeGazeTracker.js';
import { createGazeStats } from './gazeStats.js';
import { createPhoneEvidence } from './phoneEvidence.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

function tracked(yaw: number, pitch: number) {
  const tracker = createEyeGazeTracker();
  const phoneEvidence = createPhoneEvidence().sample({ score: null, fresh: false, now: 0 });
  for (let i = 0; i < 5; i += 1)
    tracker.push({
      at: i * 300,
      phoneEvidence,
      observation: {
        faces: 1,
        pose: { yaw, pitch },
        phone: false,
        earbuds: null,
        smartGlasses: null,
        blinkScore: 0,
        landmarkJitter: 0,
      },
    });
  return tracker.snapshot();
}

it('places the dot by yaw/pitch and clamps to the outer ring', () => {
  expect(dialPoint(0, 0)).toEqual({ x: 0, y: -0 });
  expect(dialPoint(22.5, 0).x).toBeCloseTo(45);
  expect(dialPoint(0, 22.5).y).toBeCloseTo(-45);
  expect(Math.hypot(dialPoint(200, 200).x, dialPoint(200, 200).y)).toBeCloseTo(90);
});

it('renders readouts, bearing and the on-screen zone', async () => {
  const view = tracked(0, -30);
  await act(async () => root.render(<GazeDial sample={view.sample} trail={view.trail} />));
  expect(container.querySelector('[data-testid="gaze-zone"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="gaze-dot"]')).not.toBeNull();
  expect(container.textContent).toContain('S 30°');
  expect(container.textContent).toContain('pitch -30°');
  expect(container.querySelectorAll('[data-sector]')).toHaveLength(8);
});

it('shows a neutral waiting state without a sample', async () => {
  await act(async () => root.render(<GazeDial sample={null} />));
  expect(container.textContent).toContain('Waiting for one clear face');
  expect(container.querySelector('[data-testid="gaze-dot"]')).toBeNull();
});

it('renders statistics without accusatory wording', async () => {
  const stats = createGazeStats();
  await act(async () => root.render(<GazeStats stats={stats.snapshot()} />));
  expect(container.textContent).toContain('Time on screen');
  expect(container.textContent).toContain('Phone detector');
  expect(container.textContent).not.toMatch(/cheat|suspicious|violation/i);
});
