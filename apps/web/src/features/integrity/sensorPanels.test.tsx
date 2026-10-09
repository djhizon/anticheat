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
it('keeps an inactive camera off without false readings or a CPU checkbox', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  await act(async () =>
    root.render(
      <CameraIntegrityPanel attempt={{ id: 'a', active: false, deadline: Date.now() + 60000 }} />,
    ),
  );
  // After the attempt ends there is nothing to start: only a readable "Monitoring ended" note.
  expect(container.textContent).toContain('Monitoring ended');
  expect(container.textContent).not.toContain('Start camera checks');
  expect(container.textContent).not.toContain('Clear');
  expect(container.textContent).not.toContain('Camera active');
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});
const camera = vi.hoisted(() => ({
  start: vi.fn(async (_value: boolean) => {}),
  publish: null as null | ((snapshot: import('./cameraSession.js').CameraSnapshot) => void),
}));
vi.mock('./cameraSession.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./cameraSession.js')>();
  return {
    ...original,
    createCameraSession: (
      _env: unknown,
      _attempt: unknown,
      publish: (snapshot: import('./cameraSession.js').CameraSnapshot) => void,
    ) => {
      camera.publish = publish;
      return {
        start: camera.start,
        stop: vi.fn(),
        destroy: vi.fn(),
        calibrate: vi.fn(),
      };
    },
  };
});
const attempt = (active: boolean) => ({ id: 'a', active, deadline: Date.now() + 60000 });

it('auto-starts camera checks once for an in-progress consented attempt', async () => {
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(true)} autoStart />));
  expect(camera.start).toHaveBeenCalledOnce();
});
it('shows students no calibration prompt, button, status or wording while live', async () => {
  const { emptyCamera } = await import('./cameraSession.js');
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(true)} autoStart />));
  await act(async () =>
    camera.publish!({
      ...emptyCamera('Camera checks running'),
      phase: 'live',
      faces: 1,
      pose: { yaw: 3, pitch: -4 },
    }),
  );
  expect(container.textContent).toContain('Camera active');
  expect(container.textContent).toContain('Gaze details');
  expect(container.textContent).not.toMatch(/calibrat|confidence|look at the|dot/i);
  for (const button of container.querySelectorAll('button'))
    expect(button.textContent).not.toMatch(/calibrat/i);
});
it('does not auto-start the camera without consent or for a submitted attempt', async () => {
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(true)} />));
  await act(async () => root.render(<CameraIntegrityPanel attempt={attempt(false)} autoStart />));
  expect(camera.start).not.toHaveBeenCalled();
});
it('auto-starts audio after one second, retries a failure a bounded number of times, then reports it', async () => {
  vi.useFakeTimers();
  try {
    mocks.acquire.mockRejectedValue(new Error('Microphone busy'));
    const unavailable = vi.fn();
    await act(async () =>
      root.render(<AudioPanel attemptId="a" active autoStart onUnavailable={unavailable} />),
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Microphone busy');
    expect(container.querySelector('button')).toBeNull();
    for (let i = 0; i < 8; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    // One initial attempt plus MAX_AUTO_RETRIES restarts, then the page is told.
    expect(mocks.acquire).toHaveBeenCalledTimes(6);
    expect(unavailable).toHaveBeenCalledWith('Microphone busy');
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
it('needs a valid Wi-Fi address before a QR and never sends invalid enrollment', async () => {
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
  expect(container.textContent).toContain("Enter this computer's Wi-Fi address first");
  const create = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Show QR code'),
  )!;
  expect(create.disabled).toBe(true);
  expect(requirePhonePresence).not.toHaveBeenCalled();
});
it('in the desktop app uses the LAN origin from the main process and shows no origin field', async () => {
  const startPhoneLan = vi.fn(async () => ({ origin: 'http://192.168.1.20:3443' }));
  Object.assign(window, { electronExam: { startPhoneLan } });
  try {
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
    expect(container.querySelector('input[type=text], input:not([type])')).toBeNull();
    expect(container.textContent).not.toContain('EXAM_LAN');
    const create = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show QR code'),
    )!;
    expect(create.disabled).toBe(false);
    expect(startPhoneLan).not.toHaveBeenCalled(); // Nothing opens before pairing is requested.
    await act(async () => create.click());
    expect(startPhoneLan).toHaveBeenCalledTimes(1);
    expect(requirePhonePresence).toHaveBeenCalledTimes(1);
    expect(
      (
        container.querySelector(
          'textarea[aria-label="Private pairing link"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('origin=http%3A%2F%2F192.168.1.20%3A3443');
  } finally {
    Reflect.deleteProperty(window, 'electronExam');
  }
});
it('in the desktop app shows the reason when the LAN listener cannot open', async () => {
  Object.assign(window, {
    electronExam: { startPhoneLan: async () => ({ origin: null, error: 'No Wi-Fi found.' }) },
  });
  try {
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
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Show QR code'))!
        .click(),
    );
    expect(container.textContent).toContain('No Wi-Fi found.');
    expect(requirePhonePresence).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(window, 'electronExam');
  }
});
it('creates a QR after a valid origin, with the link as a fallback', async () => {
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
    const input = container.querySelector('input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'http://192.168.1.10:5173',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const create = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Show QR code'),
  )!;
  expect(create.disabled).toBe(false);
  await act(async () => create.click());
  expect(requirePhonePresence).toHaveBeenCalledOnce();
  expect(container.querySelector('textarea')?.value).toContain('examcompanion://pair');
});
