import { useSyncExternalStore } from 'react';

import type { ExamApi } from '../exam/api.js';
import { createScreenRecorder, type ScreenRecorderOptions } from './screenRecorder.js';
import { registerSubmitFlush } from './submitFlush.js';

/**
 * The one mandatory screen recording of an attempt. It is started by the student's click in
 * pre-exam setup and must survive the hand-over to the exam page, so it lives at module level
 * (never persisted; a page refresh ends it and the student restarts it with one click).
 */
/** `finished`: stopped on purpose for submit (the last segments were handed over). */
export type ScreenRecordingPhase = 'idle' | 'starting' | 'running' | 'ended' | 'finished';

export interface ScreenRecordingState {
  readonly phase: ScreenRecordingPhase;
  readonly attemptId: string | null;
  /** Latest status line from the recorder (upload progress, local fallback, …). */
  readonly status: string;
  /** Why the last start failed or why recording ended; '' otherwise. */
  readonly error: string;
}

type Recorder = Pick<ReturnType<typeof createScreenRecorder>, 'start' | 'stop'> & {
  readonly finish?: (maxMs?: number) => Promise<void>;
};
export type RecorderFactory = (
  attemptId: string,
  examApi: ExamApi | undefined,
  status: (message: string) => void,
  options: ScreenRecorderOptions,
) => Recorder;

const IDLE: ScreenRecordingState = { phase: 'idle', attemptId: null, status: '', error: '' };
let state: ScreenRecordingState = IDLE;
let recorder: Recorder | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let factory: RecorderFactory = createScreenRecorder;
let unregisterFlush: (() => void) | null = null;

function set(next: Partial<ScreenRecordingState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

const INDEX_KEY = 'exam-recording-index:';

function readIndex(attemptId: string): number {
  try {
    const value = Number(sessionStorage.getItem(INDEX_KEY + attemptId));
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeIndex(attemptId: string, next: number): void {
  try {
    sessionStorage.setItem(INDEX_KEY + attemptId, String(next));
  } catch {
    // Without storage a resumed recording may reuse an index; the server then keeps it locally.
  }
}

export function screenRecordingState(): ScreenRecordingState {
  return state;
}

export function subscribeScreenRecording(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Starts (or restarts) the recording for `attemptId`. Must be called from a click: browsers and
 * the desktop app only open screen capture for a user gesture. Resolves once recording runs;
 * rejects with a student-facing message otherwise.
 */
export async function startScreenRecording(attemptId: string, examApi?: ExamApi): Promise<void> {
  if (state.phase === 'running' && state.attemptId === attemptId) return;
  recorder?.stop();
  recorder = null;
  const mine = ++generation;
  let endedEarly = '';
  set({ phase: 'starting', attemptId, error: '', status: 'Choose a screen to record…' });
  const created = factory(
    attemptId,
    examApi,
    (message) => {
      if (mine === generation) set({ status: message });
    },
    {
      firstIndex: readIndex(attemptId),
      onSegmentIndex: (next) => writeIndex(attemptId, next),
      onEnded: (reason) => {
        if (mine !== generation) return;
        endedEarly = reason;
        if (state.phase === 'running') set({ phase: 'ended', error: reason });
      },
    },
  );
  recorder = created;
  try {
    await created.start();
  } catch (error) {
    if (mine === generation) {
      recorder = null;
      set({
        phase: 'idle',
        error: error instanceof Error ? error.message : 'Screen recording could not start.',
      });
    }
    throw error;
  }
  if (mine !== generation) throw new Error('Screen recording was restarted.');
  if (endedEarly !== '') {
    recorder = null;
    set({ phase: 'idle', error: endedEarly });
    throw new Error(endedEarly);
  }
  set({ phase: 'running', error: '' });
  // Submit first hands over the last segments while the attempt still accepts uploads.
  unregisterFlush?.();
  unregisterFlush = registerSubmitFlush(() => finishScreenRecording(2500));
}

/**
 * Stops on purpose right before submit and waits (bounded) for the last segments, so they are
 * uploaded while the attempt is still open. The exam page does not treat this as a stop.
 */
export async function finishScreenRecording(maxMs = 2500): Promise<void> {
  if (state.phase !== 'running' || recorder === null) return;
  generation += 1;
  const finishing = recorder;
  recorder = null;
  set({ phase: 'finished', error: '' });
  if (finishing.finish) await finishing.finish(maxMs);
  else finishing.stop();
}

/** Submit failed after the recording was finished: answering must pause until it resumes. */
export function reopenAfterFailedSubmit(): void {
  if (state.phase === 'finished')
    set({
      phase: 'ended',
      error: 'Screen recording was stopped for submitting. Resume it to continue.',
    });
}

/** Stops on purpose (submit, leaving the exam). Not reported as an unexpected stop. */
export function stopScreenRecording(): void {
  generation += 1;
  unregisterFlush?.();
  unregisterFlush = null;
  recorder?.stop();
  recorder = null;
  if (state.phase !== 'idle') set({ phase: 'idle', error: '' });
}

export function useScreenRecording(): ScreenRecordingState {
  return useSyncExternalStore(subscribeScreenRecording, screenRecordingState, screenRecordingState);
}

/** Test seam: replace the recorder factory and reset the session. */
export function setScreenRecorderFactoryForTests(next: RecorderFactory | null): void {
  stopScreenRecording();
  factory = next ?? createScreenRecorder;
  state = IDLE;
  listeners.forEach((listener) => listener());
}
