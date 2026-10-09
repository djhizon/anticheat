import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  classifyGaze,
  createGazeReporter,
  createGazeTracker,
  type GazeEvent,
} from './gazeReporter.js';
import { createVoiceReporter } from './voiceReporter.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('classifies head direction, face count and unknown readings', () => {
  expect(classifyGaze({ faces: null, pose: null })).toBeNull();
  expect(classifyGaze({ faces: 0, pose: null })).toBe('no_face');
  expect(classifyGaze({ faces: 2, pose: { yaw: 0, pitch: 0 } })).toBe('multiple_faces');
  expect(classifyGaze({ faces: 1, pose: null })).toBeNull();
  expect(classifyGaze({ faces: 1, pose: { yaw: 5, pitch: -5 } })).toBe('forward');
  expect(classifyGaze({ faces: 1, pose: { yaw: -30, pitch: 0 } })).toBe('left');
  expect(classifyGaze({ faces: 1, pose: { yaw: 30, pitch: 0 } })).toBe('right');
  expect(classifyGaze({ faces: 1, pose: { yaw: 0, pitch: -25 } })).toBe('down');
  expect(classifyGaze({ faces: 1, pose: { yaw: 0, pitch: 25 } })).toBe('up');
});

function feed(
  tracker: ReturnType<typeof createGazeTracker>,
  start: number,
  seconds: number,
  left: boolean,
) {
  for (let s = 0; s < seconds; s += 1) {
    tracker.sample({ faces: 1, pose: { yaw: left ? -35 : 0, pitch: 0 } }, start + s * 1000);
  }
}

it('emits one event per held direction, not one per frame, and ignores glances', () => {
  const events: GazeEvent[] = [];
  const tracker = createGazeTracker((event) => events.push(event));
  feed(tracker, 0, 3, false); // forward
  feed(tracker, 3000, 1, true); // 1 s glance: below the debounce
  feed(tracker, 4000, 3, false);
  expect(events).toEqual([]);
  feed(tracker, 7000, 8, true); // held for 8 s
  feed(tracker, 15000, 3, false); // back to forward
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ direction: 'left', timestamp: 7000, yaw: -35 });
  expect(events[0]!.durationMs).toBeGreaterThanOrEqual(7000);
});

it('closes the open stretch on flush and cuts very long stretches into chunks', () => {
  const events: GazeEvent[] = [];
  const tracker = createGazeTracker((event) => events.push(event));
  for (let s = 0; s <= 70; s += 1) tracker.sample({ faces: 0, pose: null }, s * 1000);
  tracker.flush(71_000);
  expect(events.map((e) => e.direction)).toEqual(['no_face', 'no_face', 'no_face']);
  expect(events.every((e) => e.durationMs <= 31_000)).toBe(true);
});

it('batches gaze events into a single telemetry post and flags a phone once per cooldown', async () => {
  const uploadTelemetry = vi.fn(async () => {});
  const patchEvents = vi.fn(async () => ({}));
  let now = 1_000_000;
  const reporter = createGazeReporter('a1', { uploadTelemetry, patchEvents }, () => now);
  for (let s = 0; s < 12; s += 1) {
    reporter.sample({ faces: 1, pose: { yaw: 40, pitch: 0 }, phone: 'observed' });
    now += 1000;
  }
  reporter.sample({ faces: 1, pose: { yaw: 0, pitch: 0 } });
  now += 4000;
  reporter.sample({ faces: 1, pose: { yaw: 0, pitch: 0 } });
  expect(patchEvents).toHaveBeenCalledTimes(1);
  expect(patchEvents).toHaveBeenCalledWith('a1', { event: 'phone_detected' });
  expect(uploadTelemetry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(uploadTelemetry).toHaveBeenCalledTimes(1);
  const payload = uploadTelemetry.mock.calls[0] as unknown as [string, { gaze: GazeEvent[] }];
  expect(payload[1].gaze).toHaveLength(1);
  expect(payload[1].gaze[0]).toMatchObject({ direction: 'right' });
  reporter.stop();
});

it('coalesces sound pings into bursts and posts them as voice telemetry', async () => {
  const uploadTelemetry = vi.fn(async () => {});
  let now = 5_000;
  const reporter = createVoiceReporter('a1', { uploadTelemetry }, () => now);
  reporter.detected(200, -30);
  now += 1500;
  reporter.detected(200, -22);
  expect(uploadTelemetry).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3100);
  expect(uploadTelemetry).toHaveBeenCalledTimes(1);
  expect(uploadTelemetry).toHaveBeenCalledWith('a1', {
    voice: [{ timestamp: 4800, durationMs: 1700, peakDb: -22 }],
  });
});
