// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioPanel } from './AudioPanel.js';
import { appendLine } from './transcriptLog.js';
import type { ExamApi } from './../exam/api.js';

const mocks = vi.hoisted(() => ({
  recorder: null as null | {
    onTranscript: (text: string, at: number) => void;
    hooks: { onSkipped: (at: number) => void; onBusy: (busy: boolean) => void };
  },
  stopMeter: vi.fn(),
  meter: vi.fn(),
  recorderStop: vi.fn(),
}));
vi.mock('./builtInMicrophone.js', () => ({
  acquireBuiltInMicrophone: async () => ({
    getTracks: () => [],
    getAudioTracks: () => [{ label: 'Mac mic', addEventListener() {}, removeEventListener() {} }],
  }),
}));
vi.mock('./audioSession.js', () => ({
  createAudioSession: (_id: string, publish: (value: unknown) => void) => ({
    start: async () =>
      publish({
        phase: 'recording',
        reason: '',
        recordingSeconds: 0,
        voiceDetectedCount: 0,
        lastVoiceAt: null,
      }),
    destroy: () => {},
  }),
}));
vi.mock('./audioLevel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audioLevel.js')>()),
  createLevelMeter: (...args: unknown[]) => {
    mocks.meter(...args);
    return mocks.stopMeter;
  },
}));
vi.mock('./audioRecorder.js', () => ({
  createAudioRecorder: (
    _id: string,
    _api: unknown,
    onTranscript: (text: string, at: number) => void,
    _status: unknown,
    hooks: { onSkipped: (at: number) => void; onBusy: (busy: boolean) => void },
  ) => {
    mocks.recorder = { onTranscript, hooks };
    return { start: async () => {}, stop: mocks.recorderStop };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
const api = { getTranscript: vi.fn(async () => []) } as unknown as ExamApi;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.recorder = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function startAudio(examApi: ExamApi = api) {
  await act(async () => root.render(<AudioPanel attemptId="a" active examApi={examApi} />));
  await act(async () => container.querySelector('button')!.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const lines = () => [...container.querySelectorAll('.transcript-line')].map((l) => l.textContent);

it('shows a labelled REC indicator with a meter that is released on stop and unmount', async () => {
  await startAudio();
  expect(container.querySelector('.rec-indicator')?.textContent).toContain('REC');
  expect(container.querySelector('.rec-dot')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('svg.level-meter rect')).not.toBeNull();
  expect(mocks.meter).toHaveBeenCalledOnce();
  await act(async () => container.querySelector('button')!.click()); // Stop audio
  expect(mocks.stopMeter).toHaveBeenCalledOnce();
  expect(container.querySelector('.rec-indicator')).toBeNull();
  await act(async () => container.querySelector('button')!.click()); // Start again
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.meter).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  expect(mocks.stopMeter).toHaveBeenCalledTimes(2);
});

it('appends transcripts in order, ignores empty text, shows skips and a shimmer', async () => {
  await startAudio();
  const live = container.querySelector('[role="log"]');
  expect(live).toBeNull();
  const at = Date.parse('2026-10-09T01:02:03');
  await act(async () => mocks.recorder!.hooks.onBusy(true));
  expect(container.querySelector('.transcript-shimmer')?.textContent).toBe('transcribing…');
  expect(container.querySelector('.transcript-shimmer')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => mocks.recorder!.onTranscript('first', at));
  await act(async () => mocks.recorder!.onTranscript('   ', at + 1000));
  await act(async () => mocks.recorder!.hooks.onSkipped(at + 3000));
  await act(async () => mocks.recorder!.onTranscript('second', at + 6000));
  expect(lines()).toEqual([
    '01:02:03 — first',
    '01:02:06 — (skipped while transcribing)',
    '01:02:09 — second',
    'transcribing…',
  ]);
  const log = container.querySelector('[role="log"]')!;
  expect(log.getAttribute('aria-live')).toBe('polite');
  expect(log.querySelector('.transcript-shimmer')).toBeNull();
  await act(async () => mocks.recorder!.hooks.onBusy(false));
  expect(container.querySelector('.transcript-shimmer')).toBeNull();
});

it('caps the log at the newest 50 lines', () => {
  let log: ReturnType<typeof appendLine> = [];
  for (let i = 0; i < 60; i++) log = appendLine(log, { at: i, kind: 'text', text: `line ${i}` });
  expect(log).toHaveLength(50);
  expect(log[0]?.text).toBe('line 10');
  expect(log.at(-1)?.text).toBe('line 59');
});

it('restores the saved transcript after a reload', async () => {
  const getTranscript = vi.fn(async () => [
    { capturedAt: new Date(2026, 9, 9, 8, 0, 1).toISOString(), text: 'earlier words' },
  ]);
  await act(async () =>
    root.render(
      <AudioPanel attemptId="a" active examApi={{ getTranscript } as unknown as ExamApi} />,
    ),
  );
  expect(getTranscript).toHaveBeenCalledWith('a');
  expect(lines()).toEqual(['08:00:01 — earlier words']);
});
