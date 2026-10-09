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
