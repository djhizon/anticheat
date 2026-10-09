import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serverVisionText, startServerVision, type ServerVisionStatus } from './serverVision.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(send: (image: string, signal: AbortSignal) => Promise<{ label: string }[]>) {
  const statuses: ServerVisionStatus[] = [];
  const capture = vi.fn(() => 'FRAME');
  const scheduler = startServerVision({
    capture,
    send,
    onStatus: (status) => statuses.push(status),
    intervalMs: 20_000,
  });
  return { statuses, capture, scheduler };
}

it('sends a frame on each interval and reports seen / not seen', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce([{ label: 'earbuds' }, { label: 'person' }])
    .mockResolvedValueOnce([]);
  const { statuses, scheduler } = setup(send);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe('FRAME');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(statuses).toEqual([{ state: 'seen', labels: ['earbuds'] }, { state: 'not_seen' }]);
  scheduler.stop();
});

it('never overlaps requests: ticks are skipped while one is in flight', async () => {
  let release: (value: { label: string }[]) => void = () => {};
  const send = vi.fn(
    () =>
      new Promise<{ label: string }[]>((resolve) => {
        release = resolve;
      }),
  );
  const { scheduler } = setup(send);
  await vi.advanceTimersByTimeAsync(80_000);
  expect(send).toHaveBeenCalledTimes(1);
  release([]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(send).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('keeps going after a failed request and does not report it as clear', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce([]);
  const { statuses, scheduler } = setup(send);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(statuses).toEqual([{ state: 'not_seen' }]);
  scheduler.stop();
});

it('skips ticks without a frame', async () => {
  const send = vi.fn(async () => []);
  const scheduler = startServerVision({ capture: () => null, send, onStatus: () => {} });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled();
  scheduler.stop();
});

it('stops on stop(): aborts the request, ignores its reply and sends nothing more', async () => {
  let signal: AbortSignal | undefined;
  let release: (value: { label: string }[]) => void = () => {};
  const send = vi.fn(
    (_image: string, abort: AbortSignal) =>
      new Promise<{ label: string }[]>((resolve) => {
        signal = abort;
        release = resolve;
      }),
  );
  const { statuses, scheduler } = setup(send);
  await vi.advanceTimersByTimeAsync(20_000);
  scheduler.stop();
  expect(signal?.aborted).toBe(true);
  release([{ label: 'smart watch' }]);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect(statuses).toEqual([]);
});

it('renders the second-opinion line', () => {
  expect(serverVisionText({ state: 'not_checked' })).toBe(
    'Second opinion (local OWL-ViT): earbuds / headphones / smart glasses / smart watch — not checked',
  );
  expect(serverVisionText({ state: 'not_seen' })).toMatch(/— not seen$/u);
  expect(serverVisionText({ state: 'seen', labels: ['earbuds'] })).toContain('— seen: earbuds');
});
