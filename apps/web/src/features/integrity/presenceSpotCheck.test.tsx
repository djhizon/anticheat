// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_FLASHES_PER_SECOND,
  PULSE_TIMING,
  REDUCED_PULSE_TIMING,
  captureEdgePulse,
  flashesPerSecond,
} from './edgePulse.js';
import {
  DEFAULT_PRESENCE_SCHEDULE,
  TYPING_QUIET_MS,
  createBoundaryScheduler,
  presenceScheduleFromEnv,
} from './presenceSchedule.js';
import {
  PASSED_VISIBLE_MS,
  PresenceNote,
  usePresenceSpotChecks,
  type SpotCheckResult,
} from './PresenceSpotCheck.js';

const MINUTE = 60_000;
const config = { itemsMin: 2, itemsMax: 2, gapMinMs: 4 * MINUTE, gapMaxMs: 4 * MINUTE };

describe('boundary scheduler', () => {
  it('fires only at an item boundary after enough answered items and enough time', () => {
    let now = 0;
    const scheduler = createBoundaryScheduler({ config, now: () => now });
    expect(scheduler.boundary(true)).toBe(false);
    expect(scheduler.boundary(true)).toBe(false); // 2 items, but too early
    now = 4 * MINUTE;
    expect(scheduler.boundary(false)).toBe(true); // a move to another question
    scheduler.completed();
    expect(scheduler.boundary(true)).toBe(false);
  });

  it('picks the item count and the gap at random within the configured ranges', () => {
    for (const [random, items, gap] of [
      [0, 2, 4 * MINUTE],
      [0.999999, 5, 10 * MINUTE],
    ] as const) {
      let now = 0;
      const scheduler = createBoundaryScheduler({ random: () => random, now: () => now });
      now = gap - 1;
      for (let i = 0; i < items; i += 1) scheduler.boundary(true);
      expect(scheduler.boundary(false)).toBe(false);
      now = gap;
      expect(scheduler.boundary(false)).toBe(true);
    }
  });

  it('retries at the very next boundary after a miss', () => {
    const now = 0;
    const scheduler = createBoundaryScheduler({ config, now: () => now });
    scheduler.retryNext();
    expect(scheduler.boundary(false)).toBe(true);
    scheduler.completed();
    expect(scheduler.boundary(false)).toBe(false);
  });

  it('is configurable and ignores invalid values', () => {
    expect(
      presenceScheduleFromEnv({ VITE_PRESENCE_ITEMS: '3-4', VITE_PRESENCE_GAP_MINUTES: '1-2' }),
    ).toEqual({ itemsMin: 3, itemsMax: 4, gapMinMs: MINUTE, gapMaxMs: 2 * MINUTE });
    expect(presenceScheduleFromEnv({ VITE_PRESENCE_ITEMS: '5-1' })).toEqual(
      DEFAULT_PRESENCE_SCHEDULE,
    );
  });
});

describe('edge colour pulse', () => {
  it('stays at or below three flashes per second, slower with reduced motion', () => {
    expect(flashesPerSecond(PULSE_TIMING)).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    expect(flashesPerSecond(REDUCED_PULSE_TIMING)).toBeLessThanOrEqual(1);
    expect(PULSE_TIMING.opacity).toBeLessThan(0.5);
    expect(REDUCED_PULSE_TIMING.opacity).toBeLessThan(PULSE_TIMING.opacity);
    // Three colours take about 1.5 s.
    expect(3 * (PULSE_TIMING.flashMs + PULSE_TIMING.gapMs)).toBeLessThanOrEqual(2000);
  });

  it('pulses only a non-interactive screen edge and leaves the camera running', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const clone = {
      getVideoTracks: () => [{ label: 'FaceTime HD Camera' }],
      getTracks: () => [{ stop }],
    };
    const original = { clone: () => clone, getTracks: () => [{ stop: vi.fn() }] };
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const context = {
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([100, 100, 100, 255]) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const borders: string[] = [];
    const observer = new MutationObserver(() => {
      const overlay = document.querySelector<HTMLElement>('.presence-pulse');
      if (overlay) borders.push(overlay.style.borderColor);
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    try {
      const capture = captureEdgePulse(['red', 'green', 'blue'], {
        stream: original as unknown as MediaStream,
        face: () => ({ x: 0.3, y: 0.2, w: 0.4, h: 0.5 }),
      });
      await vi.advanceTimersByTimeAsync(0);
      const overlay = document.querySelector<HTMLElement>('.presence-pulse')!;
      expect(overlay.style.pointerEvents).toBe('none');
      expect(overlay.getAttribute('aria-hidden')).toBe('true');
      expect(overlay.style.background).toBe('');
      await vi.advanceTimersByTimeAsync(3 * (PULSE_TIMING.flashMs + PULSE_TIMING.gapMs));
      const evidence = await capture;
      expect(evidence.frames).toHaveLength(3);
      expect(evidence.faces).toEqual([true, true, true]);
      expect(evidence.cameraLabel).toBe('FaceTime HD Camera');
      expect(document.querySelector('.presence-pulse')).toBeNull();
      expect(stop).toHaveBeenCalled(); // only the clone is stopped
      expect(borders.some((b) => b.includes('0.45'))).toBe(true);
    } finally {
      observer.disconnect();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe('spot checks during the exam', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  let boundary: (answered: boolean) => void = () => {};
  let now = 0;
  let sinceLastKey = Infinity;
  const results: SpotCheckResult[] = [];
  const run = vi.fn(async () => results.shift() ?? 'passed');
  const reportFailed = vi.fn();

  function Harness({ paused = false }: { paused?: boolean }) {
    const checks = usePresenceSpotChecks({
      active: true,
      paused,
      run,
      reportFailed,
      sinceLastKey: () => sinceLastKey,
      config,
      now: () => now,
    });
    useEffect(() => {
      boundary = checks.itemBoundary;
    });
    return (
      <>
        <input aria-label="answer" />
        <PresenceNote phase={checks.phase} />
      </>
    );
  }
  const render = (paused = false) => act(async () => root.render(<Harness paused={paused} />));
  const note = () => container.querySelector('[aria-label="Quick presence check"]');
  const hit = (answered: boolean) => act(async () => boundary(answered));

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    sinceLastKey = Infinity;
    results.length = 0;
    run.mockClear();
    reportFailed.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.useRealTimers();
  });

  it('never runs on a timer alone, only at an item boundary, and never mid-typing', async () => {
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
    });
    now = 60 * MINUTE;
    expect(run).not.toHaveBeenCalled();
    await hit(true);
    expect(run).not.toHaveBeenCalled(); // one item so far
    sinceLastKey = TYPING_QUIET_MS - 1;
    await hit(true);
    expect(run).not.toHaveBeenCalled(); // still typing
    sinceLastKey = Infinity;
    await hit(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it('shows a tiny polite note with no buttons, keeps focus, and fades after a pass', async () => {
    await render();
    const input = container.querySelector('input')!;
    input.focus();
    now = 5 * MINUTE;
    await hit(true);
    await hit(true);
    expect(note()?.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PASSED_VISIBLE_MS);
    });
    expect(note()).toBeNull();
    expect(reportFailed).not.toHaveBeenCalled();
  });

  it('retries a miss silently at the next boundary and reports only a second miss', async () => {
    results.push('failed', 'failed');
    await render();
    now = 5 * MINUTE;
    await hit(true);
    await hit(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(note()).toBeNull(); // silent
    expect(reportFailed).not.toHaveBeenCalled();
    await hit(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(reportFailed).toHaveBeenCalledOnce();
    await hit(false);
    expect(run).toHaveBeenCalledTimes(2); // back to the normal schedule
  });

  it('a pass on the retry is not reported as a failure', async () => {
    results.push('failed', 'passed');
    await render();
    now = 5 * MINUTE;
    await hit(true);
    await hit(true);
    await hit(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(reportFailed).not.toHaveBeenCalled();
  });

  it('waits while answering is paused by the camera gate', async () => {
    await render(true);
    now = 5 * MINUTE;
    await hit(true);
    await hit(true);
    expect(run).not.toHaveBeenCalled();
    await render(false);
    await hit(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
