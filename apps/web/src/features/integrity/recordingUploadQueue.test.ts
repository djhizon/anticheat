import { expect, it, vi } from 'vitest';
import { RecordingUploadQueue } from './recordingUploadQueue.js';

const item = (index: number) => ({ index, blob: new Blob(['x']) });

it('keeps one upload in flight and uploads in FIFO order', async () => {
  const releases: Array<() => void> = [];
  const order: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = new RecordingUploadQueue({
    segmentMs: 10_000,
    upload: (entry) =>
      new Promise<void>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(entry.index);
        releases.push(() => {
          inFlight -= 1;
          resolve();
        });
      }),
  });
  queue.enqueue(item(0));
  queue.enqueue(item(1));
  queue.enqueue(item(2));
  releases.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  releases.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual([0, 1, 2]);
  expect(maxInFlight).toBe(1);
});

it('signals pressure when more than three segments wait', () => {
  const onPressure = vi.fn();
  const queue = new RecordingUploadQueue({
    segmentMs: 10_000,
    upload: () => new Promise<void>(() => {}),
    onPressure,
  });
  for (let i = 0; i < 3; i += 1) queue.enqueue(item(i));
  expect(onPressure).not.toHaveBeenCalled();
  queue.enqueue(item(3));
  expect(onPressure).toHaveBeenCalledWith('backlog');
});

it('aborts a hung upload after the timeout, counts it as a failure and gives up', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const onGiveUp = vi.fn();
  const queue = new RecordingUploadQueue({
    segmentMs: 10_000,
    upload: (_entry, signal) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    },
    maxFailuresInWindow: 2,
    onGiveUp,
  });
  queue.enqueue(item(0));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(onGiveUp).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(signals[0]!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000 + 15_000);
  expect(onGiveUp).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], 'unstable');
  vi.useRealTimers();
});

it('only counts failures inside the window, so spread-out blips do not give up', async () => {
  vi.useFakeTimers();
  let fail = true;
  const onGiveUp = vi.fn();
  const queue = new RecordingUploadQueue({
    segmentMs: 10_000,
    upload: async () => {
      if (fail) throw new Error('blip');
    },
    onGiveUp,
    retryDelayMs: 40_000,
  });
  queue.enqueue(item(0));
  await vi.advanceTimersByTimeAsync(40_000); // second failure, 40 s later
  expect(onGiveUp).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40_000); // third failure, but the first aged out
  expect(onGiveUp).not.toHaveBeenCalled();
  fail = false;
  await vi.advanceTimersByTimeAsync(40_000);
  expect(queue.uploaded).toBe(1);
  vi.useRealTimers();
});

it('hands segments beyond the waiting cap to local saving instead of holding them', () => {
  const onOverflow = vi.fn();
  const queue = new RecordingUploadQueue({
    segmentMs: 10_000,
    upload: () => new Promise<void>(() => {}),
    onOverflow,
  });
  for (let i = 0; i < 14; i += 1) queue.enqueue(item(i));
  expect(queue.waiting).toBe(12);
  expect(onOverflow).toHaveBeenCalledTimes(2);
  expect(onOverflow).toHaveBeenLastCalledWith(expect.objectContaining({ index: 13 }));
});
