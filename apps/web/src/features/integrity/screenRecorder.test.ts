// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScreenRecorder } from './screenRecorder.js';
import type { ExamApi } from '../exam/api.js';
const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./builtInMicrophone.js', () => ({ acquireBuiltInMicrophone: mocks.acquire }));
class Track extends EventTarget {
  stop = vi.fn();
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
class Recorder {
  static isTypeSupported = () => true;
  static instances: Recorder[] = [];
  state = 'inactive';
  mimeType = 'video/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Recorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['complete webm']) });
    this.onstop?.();
  }
}
let video: Track;
let mic: Track;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Recorder.instances = [];
  video = new Track();
  mic = new Track();
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', {
    mediaDevices: { getDisplayMedia: vi.fn(async () => new Stream([video])) },
  });
  mocks.acquire.mockResolvedValue(new Stream([mic]));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => 'blob:fixture');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('saves independent local segments and a final partial clip without calling any API', async () => {
  const speedtest = vi.fn();
  const uploadRecordingChunk = vi.fn();
  const recorder = createScreenRecorder('a', {
    speedtest,
    uploadRecordingChunk,
  } as unknown as ExamApi);
  await recorder.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(2);
  recorder.stop();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  expect(speedtest).not.toHaveBeenCalled();
  expect(uploadRecordingChunk).not.toHaveBeenCalled();
  expect(video.stop).toHaveBeenCalled();
  expect(mic.stop).toHaveBeenCalled();
});
it('releases screen capture if native microphone acquisition fails', async () => {
  mocks.acquire.mockRejectedValueOnce(new Error('No built-in microphone'));
  const recorder = createScreenRecorder('a');
  await expect(recorder.start()).rejects.toThrow('No built-in');
  expect(video.stop).toHaveBeenCalled();
  expect(Recorder.instances).toHaveLength(0);
});
it('does not start microphone-only capture if sharing stops while mic permission is pending', async () => {
  let resolve!: (stream: Stream) => void;
  mocks.acquire.mockImplementationOnce(
    () =>
      new Promise<Stream>((done) => {
        resolve = done;
      }),
  );
  const recorder = createScreenRecorder('a');
  const start = recorder.start();
  await Promise.resolve();
  video.dispatchEvent(new Event('ended'));
  resolve(new Stream([mic]));
  await start;
  expect(Recorder.instances).toHaveLength(0);
  expect(mic.stop).toHaveBeenCalled();
});
it('offers the final partial segment after a recorder error without restarting capture', async () => {
  const recorder = createScreenRecorder('a');
  await recorder.start();
  Recorder.instances[0]!.onerror?.();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(1);
  expect(mic.stop).toHaveBeenCalled();
});
