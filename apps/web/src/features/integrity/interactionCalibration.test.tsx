// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from './eyeGazeTracker.js';
import { createEyeGazeTracker } from './eyeGazeTracker.js';
import { GazePanel, calibrationStatusText } from './GazePanel.js';
import {
  attachInteractionCalibration,
  elementTarget,
  screenPoint,
} from './interactionCalibration.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const win = {
  innerWidth: 1000,
  innerHeight: 600,
  outerWidth: 1000,
  outerHeight: 700,
  screenX: 200,
  screenY: 100,
  screen: { width: 1400, height: 900 },
};

describe('screen-normalised coordinates', () => {
  it('maps viewport points through the window position and browser chrome', () => {
    // Top chrome 100 px; the window starts at (200, 100) on a 1400 x 900 screen.
    const centre = screenPoint(500, 250, win);
    expect(centre.x).toBeCloseTo((2 * 700) / 1400 - 1);
    expect(centre.y).toBeCloseTo(1 - (2 * 450) / 900);
    const topLeft = screenPoint(0, 0, { ...win, screenX: 0, screenY: 0, outerHeight: 600 });
    expect(topLeft).toEqual({ x: -1, y: 1 });
  });
  it('falls back to the viewport when the window position is unknown or off-screen', () => {
    expect(screenPoint(500, 300, { ...win, screen: { width: 0, height: 0 } })).toEqual({
      x: 0,
      y: 0,
    });
    expect(screenPoint(1000, 600, { ...win, screenX: 5000 })).toEqual({ x: 1, y: -1 });
  });
  it('treats small fields as precise targets and large text areas as rough ones', () => {
    const small = document.createElement('input');
    small.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 200, height: 30 }) as DOMRect;
    const big = document.createElement('textarea');
    big.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 400 }) as DOMRect;
    expect(elementTarget(small, win)!.precise).toBe(true);
    expect(elementTarget(big, win)!.precise).toBe(false);
    expect(elementTarget(document.createElement('div'), win)).toBeNull();
  });
});

describe('interaction listeners', () => {
  it('reports clicks, field focus and throttled typing without key values', () => {
    const events: InteractionEvent[] = [];
    let now = 1000;
    const input = document.createElement('input');
    input.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 20 }) as DOMRect;
    document.body.append(input);
    const detach = attachInteractionCalibration((e) => events.push(e), {
      now: () => now,
      trustedOnly: false,
    });
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 20, clientY: 30, bubbles: true }),
    );
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    now += 50;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); // throttled
    now += 300;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); // ignored
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    detach();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(events.map((e) => e.kind)).toEqual(['pointer', 'focus', 'typing', 'typing']);
    expect(events.every((e) => !('key' in e))).toBe(true);
    input.remove();
  });
  it('ignores synthetic events by default and never throws from the sink', () => {
    const sink = vi.fn(() => {
      throw new Error('boom');
    });
    const detach = attachInteractionCalibration(sink);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(sink).not.toHaveBeenCalled();
    detach();
    const loud = attachInteractionCalibration(sink, { trustedOnly: false });
    expect(() =>
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    ).not.toThrow();
    loud();
  });
});

describe('gaze panel', () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  afterEach(async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
  });

  it('student view: no calibration status, wording, prompt or buttons', async () => {
    const tracker = createEyeGazeTracker();
    await act(async () => root.render(<GazePanel tracker={tracker} live defaultOpen />));
    expect(container.textContent).toContain('Gaze details');
    expect(container.textContent).not.toMatch(/calibrat|confidence|learns as you work/i);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('instructor/debug view shows the calibration status', async () => {
    const tracker = createEyeGazeTracker();
    await act(async () => root.render(<GazePanel tracker={tracker} live showCalibration />));
    expect(container.textContent).toContain('Auto-calibrating… (learns as you work');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('words the states plainly', () => {
    const base = {
      pairs: 20,
      distanceMm: 550,
      gainFitted: { yaw: true, pitch: true },
      postureResets: 0,
    };
    expect(
      calibrationStatusText({ ...base, phase: 'calibrated', confidence: 0.83, headOnly: false }),
    ).toBe('Calibrated (confidence 83%)');
    expect(
      calibrationStatusText({ ...base, phase: 'learning', confidence: 0.2, headOnly: true }),
    ).toMatch(/^Auto-calibrating… .*using head direction$/);
  });
});
