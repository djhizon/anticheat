// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExamApi } from '../exam/api.js';
import { usePhonePresence } from './usePhonePresence.js';

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  vi.useRealTimers();
});
function Harness({ api }: { api: ExamApi }) {
  const presence = usePhonePresence('attempt', true, api);
  return (
    <button disabled={presence.blocked}>
      {presence.connected ? 'connected' : 'not connected'}
    </button>
  );
}
it('fails closed on startup and stale status, then resumes on fresh acknowledgement', async () => {
  let resolve!: (value: { required: boolean; active: boolean; remainingMs: number }) => void;
  const getPhonePresence = vi.fn(
    () =>
      new Promise<{ required: boolean; active: boolean; remainingMs: number }>((done) => {
        resolve = done;
      }),
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<Harness api={{ getPhonePresence } as unknown as ExamApi} />),
    );
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => resolve({ required: true, active: true, remainingMs: 2000 }));
    expect(container.querySelector('button')?.disabled).toBe(false);
    // Poll hangs: an old green response must expire locally, not remain trusted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2250);
    });
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => resolve({ required: true, active: true, remainingMs: 8000 }));
    expect(container.querySelector('button')?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
  expect(vi.getTimerCount()).toBe(0);
});
it('never blocks an attempt that does not require a phone, even when polls fail', async () => {
  const getPhonePresence = vi
    .fn()
    .mockResolvedValueOnce({ required: false, active: false, remainingMs: 0 })
    .mockRejectedValue(new Error('offline'));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<Harness api={{ getPhonePresence } as unknown as ExamApi} />),
    );
    expect(container.querySelector('button')?.disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getPhonePresence.mock.calls.length).toBeGreaterThan(4);
    expect(container.querySelector('button')?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
it('keeps a required, active phone usable through one transient error but blocks after 3', async () => {
  const getPhonePresence = vi
    .fn()
    .mockResolvedValueOnce({ required: true, active: true, remainingMs: 60000 })
    .mockRejectedValueOnce(new Error('blip'))
    .mockResolvedValueOnce({ required: true, active: true, remainingMs: 60000 })
    .mockRejectedValue(new Error('offline'));
  const container = document.createElement('div');
  const root = createRoot(container);
  const disabled = () => container.querySelector('button')?.disabled;
  try {
    await act(async () =>
      root.render(<Harness api={{ getPhonePresence } as unknown as ExamApi} />),
    );
    expect(disabled()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // blip
    });
    expect(disabled()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // recovers, failure count resets
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // two failures
    });
    expect(disabled()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // third consecutive failure
    });
    expect(disabled()).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
