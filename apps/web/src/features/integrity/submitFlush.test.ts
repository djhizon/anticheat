import { afterEach, expect, it, vi } from 'vitest';

import { registerSubmitFlush, runSubmitFlushes } from './submitFlush.js';

afterEach(() => vi.useRealTimers());

it('waits for registered flushes, ignores failures, and stops waiting after the bound', async () => {
  const done = vi.fn();
  const off = [
    registerSubmitFlush(async () => done()),
    registerSubmitFlush(() => Promise.reject(new Error('boom'))),
  ];
  await runSubmitFlushes();
  expect(done).toHaveBeenCalledOnce();
  off.forEach((fn) => fn());

  vi.useFakeTimers();
  const stuck = registerSubmitFlush(() => new Promise<void>(() => {}));
  const finished = vi.fn();
  void runSubmitFlushes(3000).then(finished);
  await vi.advanceTimersByTimeAsync(2999);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(finished).toHaveBeenCalledOnce();
  stuck();
});
