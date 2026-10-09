// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ExamApi } from '../exam/api.js';
import { HEAD_TURN_TIMEOUT_MS, LivenessModal, NOT_VERIFIED_COPY } from './LivenessModal.js';

const mocks = vi.hoisted(() => ({ flash: vi.fn() }));
vi.mock('./livenessCapture.js', async (original) => ({
  ...(await original<typeof import('./livenessCapture.js')>()),
  captureColourFlash: mocks.flash,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

const challenge = (type: 'colour_flash' | 'head_turn') => ({
  nonce: 'n',
  type,
  data: { sequence: type === 'head_turn' ? ['left', 'right'] : ['red', 'green', 'blue'] },
  expiresAt: 'x',
  signature: 's',
});

function api(overrides: Partial<ExamApi> = {}) {
  return {
    postLivenessChallenge: vi.fn(async () => challenge('colour_flash')),
    postLivenessVerify: vi.fn(),
    ...overrides,
  } as unknown as ExamApi & { postLivenessChallenge: ReturnType<typeof vi.fn> };
}

const buttons = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('moves to an error state with Close available when the capture hangs', async () => {
  mocks.flash.mockReturnValue(new Promise(() => {}));
  const onComplete = vi.fn();
  await act(async () =>
    root.render(<LivenessModal attemptId="a" examApi={api()} onComplete={onComplete} />),
  );
  await act(async () => buttons('Start')!.click());
  expect(container.textContent).toContain('Warning');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEAD_TURN_TIMEOUT_MS + 10);
  });
  expect(container.textContent).toContain(NOT_VERIFIED_COPY);
  expect(container.textContent).toContain('took too long');
  expect(buttons('Try again')).toBeDefined();
  await act(async () => buttons('Close')!.click());
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith(false);
});

it('closes as not verified on Escape, and always shows Close', async () => {
  const onComplete = vi.fn();
  await act(async () =>
    root.render(<LivenessModal attemptId="a" examApi={api()} onComplete={onComplete} />),
  );
  expect(buttons('Close')).toBeDefined();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(onComplete).toHaveBeenCalledWith(false);
});

it('defaults to the head turn when reduced motion is preferred', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
  const examApi = api();
  await act(async () =>
    root.render(<LivenessModal attemptId="a" examApi={examApi} onComplete={vi.fn()} />),
  );
  expect(examApi.postLivenessChallenge).toHaveBeenCalledWith('a', 'head_turn');
});

it('requests the default flash challenge without reduced motion', async () => {
  const examApi = api();
  await act(async () =>
    root.render(<LivenessModal attemptId="a" examApi={examApi} onComplete={vi.fn()} />),
  );
  expect(examApi.postLivenessChallenge).toHaveBeenCalledWith('a', undefined);
});

it('labels a client-scored pass as client-measured and completes once', async () => {
  mocks.flash.mockResolvedValue({ cameraLabel: 'cam', baseline: {}, frames: [] });
  const examApi = api({
    postLivenessVerify: vi.fn(async () => ({ passed: true, layer: 3, detail: 'ok' })),
  });
  const onComplete = vi.fn();
  await act(async () =>
    root.render(<LivenessModal attemptId="a" examApi={examApi} onComplete={onComplete} />),
  );
  await act(async () => buttons('Start')!.click());
  expect(container.textContent).toContain('client-measured');
  await act(async () => buttons('Continue')!.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith(true);
});
