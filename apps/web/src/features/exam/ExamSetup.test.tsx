// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExamApi } from './api.js';
import { ExamSetup, PAIRED_ADVANCE_MS } from './ExamSetup.js';
import { loadSetupProgress, saveSetupProgress } from './setupFlow.js';

const liveness = vi.hoisted(() => ({ fail: () => {} }));
vi.mock('../integrity/LivenessModal.js', () => ({
  LivenessModal: (props: { onFailedAttempt?: () => void }) => {
    liveness.fail = () => props.onFailedAttempt?.();
    return <p>presence check</p>;
  },
}));
vi.mock('../integrity/CameraGatePanel.js', () => {
  const stream = { getTracks: () => [], getVideoTracks: () => [], clone: () => stream };
  const state = { phase: 'ok', label: 'Built-in camera' };
  return {
    CameraGatePanel: () => null,
    useCameraGate: () => ({
      state,
      cameras: { native: [], virtual: [] },
      stream,
      run: async () => ({ state: 'ok', stream }),
      reset: () => {},
    }),
  };
});
vi.mock('../integrity/builtInMicrophone.js', () => ({
  acquireBuiltInMicrophone: async () => ({
    getTracks: () => [],
    getAudioTracks: () => [],
  }),
}));
const presence = vi.hoisted(() => ({ connected: false }));
vi.mock('../integrity/usePhonePresence.js', () => ({
  usePhonePresence: () => ({ connected: presence.connected, required: null, checking: false }),
}));
vi.mock('../integrity/PhonePairingPanel.js', () => ({
  PhonePairingPanel: () => <p>pairing panel</p>,
}));
const face = vi.hoisted(() => ({
  state: { phase: 'passed' } as Record<string, unknown>,
}));
vi.mock('../integrity/faceInView.js', () => ({ useFaceInView: () => face.state }));
const rec = vi.hoisted(() => ({
  state: { phase: 'running', attemptId: 'attempt-1', status: '', error: '' } as {
    phase: string;
    attemptId: string | null;
    status: string;
    error: string;
  },
  listeners: new Set<() => void>(),
  start: (async () => {}) as (attemptId: string) => Promise<void>,
}));
vi.mock('../integrity/screenRecordingSession.js', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    rec.listeners.add(listener);
    return () => rec.listeners.delete(listener);
  };
  return {
    useScreenRecording: () => useSyncExternalStore(subscribe, () => rec.state),
    startScreenRecording: (attemptId: string) => rec.start(attemptId),
    stopScreenRecording: () => {},
  };
});
function setRecording(next: Partial<typeof rec.state>) {
  rec.state = { ...rec.state, ...next };
  rec.listeners.forEach((listener) => listener());
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
const getUserMedia = vi.fn();
const ensureAttempt = vi.fn(async () => 'attempt-1');
const onBegin = vi.fn(async () => {});

beforeEach(() => {
  sessionStorage.clear();
  presence.connected = false;
  face.state = { phase: 'passed' };
  rec.state = { phase: 'running', attemptId: 'attempt-1', status: '', error: '' };
  rec.start = async () => {};
  Reflect.deleteProperty(window, 'electronExam');
  getUserMedia.mockReset();
  ensureAttempt.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [] },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

const render = () =>
  act(async () =>
    root.render(
      <ExamSetup
        assignmentId="as1"
        title="Exam"
        examApi={{} as unknown as ExamApi}
        attemptId={null}
        ensureAttempt={ensureAttempt}
        onBegin={onBegin}
        onCancel={() => {}}
      />,
    ),
  );
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const heading = () => container.querySelector('h2')!.textContent;

it('keeps Next disabled until consent is given, then creates the attempt and moves on', async () => {
  await render();
  expect(heading()).toBe('Consent');
  expect(container.textContent).toContain('cannot pause or stop them yourself');
  expect(button('Next').disabled).toBe(true);
  expect(button('Back').disabled).toBe(true);
  await act(async () =>
    (container.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  );
  expect(button('Next').disabled).toBe(false);
  expect(ensureAttempt).not.toHaveBeenCalled();
  await act(async () => button('Next').click());
  expect(ensureAttempt).toHaveBeenCalledOnce();
  expect(heading()).toBe('Permissions');
  expect(document.activeElement).toBe(container.querySelector('h2'));
  expect(container.querySelector('[aria-current="step"]')).not.toBeNull();
});

it('gates the permissions step on both permissions and shows fix steps when blocked', async () => {
  saveSetupProgress('as1', {
    step: 'permissions',
    consent: true,
    phone: false,
    identity: false,
  });
  getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
    if (constraints.audio) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    return { getTracks: () => [{ stop() {} }] };
  });
  await render();
  expect(heading()).toBe('Permissions');
  expect(button('Next').disabled).toBe(true);
  await act(async () => button('Allow camera & microphone').click());
  expect(container.textContent).toContain('Camera: Allowed ✓');
  expect(container.textContent).toContain('Microphone: Blocked ✗');
  expect(container.querySelector('.setup-fix')?.textContent).toContain('Microphone');
  expect(button('Next').disabled).toBe(true);

  getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop() {} }] }));
  await act(async () => button('Check again').click());
  expect(container.textContent).toContain('Microphone: Allowed ✓');
  expect(button('Next').disabled).toBe(false);
});

it('never shows a step beyond one that has not passed after a refresh', async () => {
  saveSetupProgress('as1', {
    step: 'ready',
    consent: false,
    phone: false,
    identity: false,
  });
  await render();
  await act(async () => {});
  expect(heading()).not.toBe('Ready');
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
    'Start exam',
  );
});

it('lets the student continue for instructor review after three failed presence checks', async () => {
  saveSetupProgress('as1', {
    step: 'identity',
    consent: true,
    phone: true,
    identity: false,
  });
  const patchEvents = vi.fn(async () => ({}));
  await act(async () =>
    root.render(
      <ExamSetup
        assignmentId="as1"
        title="Exam"
        examApi={{ patchEvents } as unknown as ExamApi}
        attemptId="attempt-1"
        ensureAttempt={ensureAttempt}
        onBegin={onBegin}
        onCancel={() => {}}
      />,
    ),
  );
  await act(async () => {});
  expect(heading()).toBe('Identity');
  const review = () =>
    [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Continue — your instructor will review this'),
    );
  for (let i = 0; i < 2; i += 1) await act(async () => liveness.fail());
  expect(review()).toBeUndefined();
  await act(async () => liveness.fail());
  expect(review()).toBeDefined();
  expect(patchEvents).not.toHaveBeenCalled();
  await act(async () => review()!.click());
  expect(patchEvents).toHaveBeenCalledWith('attempt-1', { event: 'liveness_unverified' });
  expect(button('Next').disabled).toBe(false);
  expect(loadSetupProgress('as1')).toMatchObject({ identity: true, identityUnverified: true });
  await act(async () => button('Next').click());
  expect(heading()).toBe('Ready');
  expect(container.textContent).toContain('your instructor will review this');
});

const renderWithAttempt = (props: { patchEvents?: () => unknown } = {}) =>
  act(async () =>
    root.render(
      <ExamSetup
        assignmentId="as1"
        title="Exam"
        examApi={{ patchEvents: props.patchEvents ?? (async () => ({})) } as unknown as ExamApi}
        attemptId="attempt-1"
        ensureAttempt={ensureAttempt}
        onBegin={onBegin}
        onCancel={() => {}}
      />,
    ),
  );

it('passes the camera step only once a single face is in view', async () => {
  saveSetupProgress('as1', { step: 'camera', consent: true, phone: false, identity: false });
  getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop() {} }] }));
  face.state = { phase: 'watching', verdict: 'no_face', dark: true };
  await renderWithAttempt();
  await act(async () => button('Allow camera & microphone').click());
  await act(async () => button('Next').click());
  expect(heading()).toBe('Camera');
  expect(container.textContent).toContain("We can't see your face — sit in front of the camera.");
  expect(container.querySelector('[aria-label="Lighting tips"]')).not.toBeNull();
  expect(button('Next').disabled).toBe(true);

  face.state = { phase: 'watching', verdict: 'multiple', dark: false };
  await renderWithAttempt();
  expect(container.textContent).toContain('Only you should be in view');
  expect(button('Next').disabled).toBe(true);

  face.state = { phase: 'passed' };
  await renderWithAttempt();
  await act(async () => {});
  expect(container.textContent).toContain('Face detected ✓');
  expect(button('Next').disabled).toBe(false);
});

it('blocks the camera step when the desktop app attests a virtual camera', async () => {
  const getCameraAttestation = vi.fn(async () => ({ virtual: true }));
  Object.assign(window, { electronExam: { getCameraAttestation } });
  saveSetupProgress('as1', { step: 'camera', consent: true, phone: false, identity: false });
  getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop() {} }] }));
  await renderWithAttempt();
  await act(async () => button('Allow camera & microphone').click());
  await act(async () => button('Next').click());
  await act(async () => {});
  expect(getCameraAttestation).toHaveBeenCalledWith('Built-in camera');
  expect(container.textContent).toContain('virtual camera, which is not allowed');
  expect(container.textContent).not.toContain('Face detected');
  expect(button('Next').disabled).toBe(true);
});

it('keeps Next disabled on the screen step until whole-screen recording runs', async () => {
  saveSetupProgress('as1', { step: 'screen', consent: true, phone: false, identity: false });
  rec.state = { phase: 'idle', attemptId: null, status: '', error: '' };
  const patchEvents = vi.fn(async () => ({}));
  let attempts = 0;
  rec.start = async (attemptId) => {
    attempts += 1;
    if (attempts === 1)
      throw new Error('You shared a window or a browser tab. The exam records your entire screen.');
    setRecording({ phase: 'running', attemptId });
  };
  await renderWithAttempt({ patchEvents });
  await act(async () => {});
  expect(heading()).toBe('Screen recording');
  expect(container.textContent).toContain('Entire screen');
  expect(button('Next').disabled).toBe(true);

  await act(async () => button('Start screen recording').click());
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'You shared a window or a browser tab',
  );
  expect(button('Next').disabled).toBe(true);

  await act(async () => button('Start screen recording').click());
  expect(container.textContent).toContain('Screen recording is on ✓');
  expect(button('Next').disabled).toBe(false);
  expect(patchEvents).toHaveBeenCalledWith('attempt-1', { event: 'recording_started' });

  // Sharing ends while still in setup: the step is no longer passed.
  await act(async () =>
    setRecording({
      phase: 'ended',
      error: 'Screen sharing ended. Segments captured so far were kept.',
    }),
  );
  expect(button('Next').disabled).toBe(true);
  expect(container.textContent).toContain('Screen sharing ended');
});

it('always requires the iPhone: no skip, then Paired ✓ and moves on by itself', async () => {
  saveSetupProgress('as1', { step: 'phone', consent: true, phone: false, identity: false });
  const patchEvents = vi.fn(async () => ({}));
  await renderWithAttempt({ patchEvents });
  await act(async () => {});
  expect(heading()).toBe('iPhone');
  expect(container.textContent).toContain('pairing panel');
  expect(button('Skip — no iPhone')).toBeUndefined();
  expect(container.textContent).not.toMatch(/desk camera|placement/i);
  expect(button('Next').disabled).toBe(true);

  // Heartbeats start arriving from the paired phone.
  vi.useFakeTimers();
  try {
    presence.connected = true;
    await renderWithAttempt({ patchEvents });
    expect(container.textContent).toContain('Paired ✓');
    expect(container.textContent).toContain('face-down on the desk');
    expect(patchEvents).toHaveBeenCalledWith('attempt-1', { event: 'iphone_paired' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAIRED_ADVANCE_MS);
    });
    expect(heading()).toBe('Identity');
  } finally {
    vi.useRealTimers();
  }
});
