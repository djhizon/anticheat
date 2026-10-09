// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AudioPanel } from './AudioPanel.js';
import { CameraIntegrityPanel } from './CameraIntegrityPanel.js';
import { NativePhoneModal } from './NativePhoneModal.js';
import type { ExamApi } from '../exam/api.js';
const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./builtInMicrophone.js', () => ({ acquireBuiltInMicrophone: mocks.acquire }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it('does not acquire audio on mount and displays real start errors', async () => {
  mocks.acquire.mockRejectedValueOnce(new Error('Native microphone unavailable'));
  await act(async () => root.render(<AudioPanel attemptId="a" active />));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Listening');
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Native microphone unavailable');
  expect(container.textContent).toContain('Retry audio');
});
it('keeps an inactive camera off without false readings or a CPU checkbox', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  await act(async () =>
    root.render(
      <CameraIntegrityPanel attempt={{ id: 'a', active: false, deadline: Date.now() + 60000 }} />,
    ),
  );
  expect(container.textContent).toContain('Start camera checks');
  expect(container.textContent).not.toContain('Clear');
  expect(container.textContent).not.toContain('Camera active');
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('button')!.disabled).toBe(true);
});
const camera = vi.hoisted(() => ({ start: vi.fn(async (_value: boolean) => {}) }));
vi.mock('./cameraSession.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./cameraSession.js')>();
  return {
    ...original,
    createCameraSession: () => ({
      start: camera.start,
      stop: vi.fn(),
      destroy: vi.fn(),
      calibrate: vi.fn(),
    }),
  };
});
const attempt = (active: boolean) => ({ id: 'a', active, deadline: Date.now() + 60000 });

it('auto-starts camera checks once for an in-progress consented attempt', async () => {
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(true)} autoStart />));
  expect(camera.start).toHaveBeenCalledOnce();
});
it('does not auto-start the camera without consent or for a submitted attempt', async () => {
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(true)} />));
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(false)} autoStart />));
  expect(camera.start).not.toHaveBeenCalled();
});
it('auto-starts audio about one second after mount and does not retry a failure', async () => {
  vi.useFakeTimers();
  try {
    mocks.acquire.mockRejectedValue(new Error('Microphone busy'));
    await act(async () => root.render(<AudioPanel attemptId="a" active autoStart />));
    expect(mocks.acquire).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Microphone busy');
    expect(container.textContent).toContain('Retry audio');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it('does not auto-start audio for a submitted attempt or without consent', async () => {
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<AudioPanel attemptId="a" active={false} autoStart />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => root.render(<AudioPanel attemptId="a" active />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('explains why consent alone cannot enable a QR and never sends invalid enrollment', async () => {
  const requirePhonePresence = vi.fn();
  await act(async () =>
    root.render(
      <NativePhoneModal
        attemptId="a"
        api={{ requirePhonePresence } as unknown as ExamApi}
        onClose={() => {}}
      />,
    ),
  );
  await act(async () =>
    (container.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  expect(container.textContent).toContain('Enter the laptop Wi-Fi address first');
  const create = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('create QR'),
  )!;
  expect(create.disabled).toBe(true);
  expect(requirePhonePresence).not.toHaveBeenCalled();
});
it('creates a QR after valid origin and consent', async () => {
  const requirePhonePresence = vi.fn(async () => ({
    code: 'a'.repeat(43),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  }));
  await act(async () =>
    root.render(
      <NativePhoneModal
        attemptId="a"
        api={{ requirePhonePresence } as unknown as ExamApi}
        onClose={() => {}}
      />,
    ),
  );
  await act(async () => {
    const input = container.querySelector('input:not([type=checkbox])') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'http://192.168.1.10:5173',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('input[type=checkbox]') as HTMLInputElement).click();
  });
  const create = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('create QR'),
  )!;
  expect(create.disabled).toBe(false);
  await act(async () => create.click());
  expect(requirePhonePresence).toHaveBeenCalledOnce();
  expect(container.querySelector('textarea')?.value).toContain('examcompanion://pair');
});
