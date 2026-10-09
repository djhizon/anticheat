// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScreenRecorderOptions } from './screenRecorder.js';
import { runSubmitFlushes } from './submitFlush.js';
import {
  reopenAfterFailedSubmit,
  screenRecordingState,
  setScreenRecorderFactoryForTests,
  startScreenRecording,
  stopScreenRecording,
} from './screenRecordingSession.js';

let options: ScreenRecorderOptions = {};
const start = vi.fn(async () => {});
const stop = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  start.mockReset().mockResolvedValue(undefined);
  stop.mockReset();
  setScreenRecorderFactoryForTests((_attempt, _api, _status, given) => {
    options = given;
    return { start, stop };
  });
});
afterEach(() => setScreenRecorderFactoryForTests(null));

it('runs once started and reports an unexpected end', async () => {
  await startScreenRecording('a1');
  expect(screenRecordingState()).toMatchObject({ phase: 'running', attemptId: 'a1' });
  options.onEnded?.('Screen sharing ended.');
  expect(screenRecordingState()).toMatchObject({ phase: 'ended', error: 'Screen sharing ended.' });
});

it('keeps a failed start idle with its message (e.g. a shared window)', async () => {
  start.mockRejectedValueOnce(new Error('You shared a window or a browser tab.'));
  await expect(startScreenRecording('a1')).rejects.toThrow('shared a window');
  expect(screenRecordingState()).toMatchObject({
    phase: 'idle',
    error: 'You shared a window or a browser tab.',
  });
});

it('continues segment numbering on resume and stops on purpose without an error', async () => {
  await startScreenRecording('a1');
  expect(options.firstIndex).toBe(0);
  options.onSegmentIndex?.(12);
  options.onEnded?.('ended');
  await startScreenRecording('a1');
  expect(options.firstIndex).toBe(12);
  stopScreenRecording();
  expect(stop).toHaveBeenCalled();
  expect(screenRecordingState()).toMatchObject({ phase: 'idle', error: '' });
});

it('hands the last segments over before submit, and reopens if submit fails', async () => {
  const finish = vi.fn(async () => {});
  setScreenRecorderFactoryForTests(() => ({ start, stop, finish }));
  await startScreenRecording('a1');
  await runSubmitFlushes(1000);
  expect(finish).toHaveBeenCalledWith(2500);
  expect(screenRecordingState()).toMatchObject({ phase: 'finished', attemptId: 'a1' });
  reopenAfterFailedSubmit();
  expect(screenRecordingState().phase).toBe('ended');
});
