// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExamDeliveryProjection } from '@examguard/contracts/exam';
import type { ExamApi } from './api.js';
import { StudentExamPage } from './StudentExamPage.js';
import { holdSensorStreams, releaseSensorStreams } from '../integrity/sensorHub.js';
import {
  setScreenRecorderFactoryForTests,
  startScreenRecording,
  screenRecordingState,
} from '../integrity/screenRecordingSession.js';
import type { ScreenRecorderOptions } from '../integrity/screenRecorder.js';

vi.mock('../integrity/CameraIntegrityPanel.js', () => ({
  CameraIntegrityPanel: () => <p>camera panel</p>,
}));
vi.mock('../integrity/AudioPanel.js', () => ({ AudioPanel: () => <p>audio panel</p> }));
const phone = vi.hoisted(() => ({
  state: { connected: false, required: null as boolean | null, checking: false },
}));
vi.mock('../integrity/usePhonePresence.js', () => ({ usePhonePresence: () => phone.state }));
vi.mock('../integrity/PhonePairingPanel.js', () => ({
  PhonePairingPanel: () => <p>pairing panel</p>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

const liveStream = () =>
  ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) as unknown as MediaStream;

let ended: ((reason: string) => void) | undefined;
const recorderStart = vi.fn(async () => {});
beforeEach(() => {
  sessionStorage.clear();
  phone.state = { connected: false, required: null, checking: false };
  setScreenRecorderFactoryForTests((_attemptId, _api, _status, options: ScreenRecorderOptions) => {
    ended = options.onEnded;
    return { start: recorderStart, stop: () => {} };
  });
  holdSensorStreams({ camera: liveStream(), microphone: liveStream() });
  vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  releaseSensorStreams();
  setScreenRecorderFactoryForTests(null);
  vi.restoreAllMocks();
});

function delivery(status: string): ExamDeliveryProjection {
  return {
    exam: { id: 'e', versionId: 'v', title: 'Exam', versionNumber: 1, durationSeconds: 600 },
    assignment: { id: 'as', title: 'Exam' },
    attempt: {
      id: 'a',
      status,
      effectiveDeadline: new Date(Date.now() + 600000).toISOString(),
      submittedAt: status === 'submitted' ? new Date().toISOString() : null,
    },
    questions: [{ id: 'q1', type: 'short_answer', prompt: 'Explain hashing.', options: [] }],
    answers: { revision: 0, answers: {}, savedAt: null },
  } as unknown as ExamDeliveryProjection;
}

function api() {
  return {
    patchEvents: vi.fn(async () => ({})),
    saveAnswers: vi.fn(async () => ({ revision: 1 })),
    submitAttempt: vi.fn(async () => ({
      delivery: delivery('submitted'),
      receipt: { status: 'submitted' },
    })),
    whenIdle: vi.fn(async () => {}),
  } as unknown as ExamApi & {
    patchEvents: ReturnType<typeof vi.fn>;
    submitAttempt: ReturnType<typeof vi.fn>;
  };
}

const render = (examApi: ExamApi, setup = { identityVerified: true, phoneUsed: false }) =>
  act(async () =>
    root.render(
      <StudentExamPage
        delivery={delivery('in_progress')}
        error={null}
        loading={false}
        onBack={() => {}}
        examApi={examApi}
        sensorsConsented
        setup={setup}
      />,
    ),
  );
const answerInput = () =>
  container.querySelector('input[aria-label="Written answer"]') as HTMLInputElement;
const buttons = () => [...container.querySelectorAll('button')];
const button = (name: string) => buttons().find((b) => b.textContent?.trim() === name);

it('pauses answering when screen recording stops and resumes with one button', async () => {
  await startScreenRecording('a');
  const examApi = api();
  await render(examApi);
  expect(container.querySelector('[aria-label="Screen recording stopped"]')).toBeNull();
  expect(answerInput().disabled).toBe(false);

  // The student stops sharing (track ended).
  await act(async () => ended?.('Screen sharing ended. Segments captured so far were kept.'));
  const overlay = container.querySelector('[aria-label="Screen recording stopped"]')!;
  expect(overlay).not.toBeNull();
  expect(overlay.querySelectorAll('button')).toHaveLength(1);
  expect(overlay.textContent).toContain('Screen sharing ended');
  expect(answerInput().disabled).toBe(true);
  expect(examApi.patchEvents).toHaveBeenCalledWith('a', { event: 'screen_recording_stopped' });

  await act(async () => button('Resume screen recording')!.click());
  expect(screenRecordingState().phase).toBe('running');
  expect(container.querySelector('[aria-label="Screen recording stopped"]')).toBeNull();
  expect(answerInput().disabled).toBe(false);
  expect(examApi.patchEvents).toHaveBeenCalledWith('a', { event: 'screen_recording_resumed' });
});

it('asks to resume recording after a refresh (no recording yet) and logs it once', async () => {
  const examApi = api();
  await render(examApi);
  expect(button('Resume screen recording')).toBeDefined();
  expect(answerInput().disabled).toBe(true);
  await render(examApi);
  expect(
    examApi.patchEvents.mock.calls.filter(
      (call: unknown[]) => (call[1] as { event: string }).event === 'screen_recording_stopped',
    ),
  ).toHaveLength(1);
});

it('never blocks answering or Submit for a phone that has not paired yet', async () => {
  await startScreenRecording('a');
  // The requirement was enabled (QR created) but no phone ever connected.
  phone.state = { connected: false, required: true, checking: false };
  const examApi = api();
  await render(examApi);
  expect(container.querySelector('.phone-lost-banner')).toBeNull();
  expect(container.textContent).not.toContain('answering paused');
  expect(answerInput().disabled).toBe(false);
  expect(button('Submit Exam')!.disabled).toBe(false);
  expect(examApi.patchEvents).not.toHaveBeenCalledWith('a', { event: 'iphone_disconnected' });
});

it('shows only a banner when a paired phone drops; answering and Submit stay available', async () => {
  await startScreenRecording('a');
  phone.state = { connected: true, required: true, checking: false };
  const examApi = api();
  await render(examApi, { identityVerified: true, phoneUsed: true });
  expect(container.querySelector('.phone-lost-banner')).toBeNull();
  expect(container.querySelector('[aria-label="Monitoring status"]')?.textContent).toContain(
    'iPhone Connected',
  );
  phone.state = { connected: false, required: true, checking: false };
  await render(examApi, { identityVerified: true, phoneUsed: true });
  expect(container.querySelector('.phone-lost-banner')?.textContent).toContain(
    'iPhone disconnected',
  );
  expect(container.querySelector('[aria-label="Monitoring status"]')?.textContent).toContain(
    'iPhone Lost',
  );
  expect(answerInput().disabled).toBe(false);
  expect(button('Submit Exam')!.disabled).toBe(false);
  expect(examApi.patchEvents).toHaveBeenCalledWith('a', { event: 'iphone_disconnected' });
});

it('shows only "Submitted" in the top bar after a successful submit', async () => {
  await startScreenRecording('a');
  const examApi = api();
  await render(examApi);
  await act(async () => button('Submit Exam')!.click());
  await act(async () => {});
  expect(examApi.submitAttempt).toHaveBeenCalledOnce();
  const topbar = container.querySelector('.exam-topbar')!;
  expect(topbar.textContent).toContain('Submitted');
  expect(topbar.textContent).not.toContain('Not saved');
  expect(topbar.textContent).not.toContain('Saved');
  // Recording stops on purpose with the exam; no "stopped" pause is logged.
  expect(screenRecordingState().phase).toBe('idle');
  expect(examApi.patchEvents).toHaveBeenCalledWith('a', { event: 'recording_stopped' });
  expect(examApi.patchEvents).not.toHaveBeenCalledWith('a', { event: 'screen_recording_stopped' });
});
