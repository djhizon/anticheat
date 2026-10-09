import { describe, expect, it } from 'vitest';
import { analyseLighting, type LightingReport } from './lightingAnalysis.js';
import {
  createLightingTracker,
  LIGHTING_POOR_AFTER_MS,
  LIGHTING_RECOVER_AFTER_MS,
  LIGHTING_RELOG_MS,
} from './lightingMonitor.js';

const frame = (value: number) => ({ frames: [new Float32Array(64 * 64).fill(value)] });
const report = (value: number): LightingReport => analyseLighting(frame(value))!;
const dark = report(20);
const good = report(130);

function setup() {
  let now = 0;
  const tracker = createLightingTracker(() => now);
  return { tracker, advance: (ms: number) => (now += ms) };
}

describe('in-exam lighting tracker', () => {
  it('stays quiet until lighting has been poor for 20 s, then shows a banner and logs once', () => {
    const { tracker, advance } = setup();
    expect(tracker.observe(dark)).toEqual({ banner: null, log: null });
    advance(LIGHTING_POOR_AFTER_MS - 1000);
    expect(tracker.observe(dark).banner).toBeNull();
    advance(1000);
    const verdict = tracker.observe(dark);
    expect(verdict.banner?.class).toBe('too_dark');
    expect(verdict.log?.class).toBe('too_dark');
    advance(5000);
    const next = tracker.observe(dark);
    expect(next.banner).not.toBeNull();
    expect(next.log).toBeNull();
  });

  it('logs again only after the re-log interval', () => {
    const { tracker, advance } = setup();
    tracker.observe(dark);
    advance(LIGHTING_POOR_AFTER_MS);
    expect(tracker.observe(dark).log).not.toBeNull();
    advance(LIGHTING_RELOG_MS);
    expect(tracker.observe(dark).log).not.toBeNull();
  });

  it('ignores a brief good sample but hides the banner after sustained recovery', () => {
    const { tracker, advance } = setup();
    tracker.observe(dark);
    advance(LIGHTING_POOR_AFTER_MS);
    tracker.observe(dark);
    advance(5000);
    expect(tracker.observe(good).banner).not.toBeNull();
    advance(LIGHTING_RECOVER_AFTER_MS);
    expect(tracker.observe(good).banner).toBeNull();
  });

  it('never warns for lighting that is merely dim, uneven or fine', () => {
    const { tracker, advance } = setup();
    const dim = report(65);
    expect(dim.class).toBe('dim');
    tracker.observe(dim);
    advance(LIGHTING_POOR_AFTER_MS * 3);
    expect(tracker.observe(dim)).toEqual({ banner: null, log: null });
  });

  it('keeps the current state when no frame was available', () => {
    const { tracker, advance } = setup();
    tracker.observe(dark);
    advance(LIGHTING_POOR_AFTER_MS);
    tracker.observe(dark);
    expect(tracker.observe(null).banner).not.toBeNull();
  });
});
