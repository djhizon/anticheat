// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScreenRecorder } from './screenRecorder.js';
import { ExamApiError, type ExamApi } from '../exam/api.js';
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
  options: { videoBitsPerSecond?: number } = {};
  constructor(_stream?: unknown, options: { videoBitsPerSecond?: number } = {}) {
    this.options = options;
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
it('without an API it saves local segments and a final partial clip and never calls the network', async () => {
  const speedtest = vi.fn();
  const uploadRecordingChunk = vi.fn();
  const recorder = createScreenRecorder('a');
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

function cloudApi(upload: () => Promise<void>) {
  return {
    speedtest: vi.fn(),
    uploadRecordingChunk: vi.fn(upload),
  } as unknown as ExamApi & { uploadRecordingChunk: ReturnType<typeof vi.fn> };
}
const encode = async () => 'AAAA';

it('uses the fast profile, uploads 10 s segments one at a time and steps down on backlog', async () => {
  const api = cloudApi(() => new Promise<void>(() => {}));
  const messages: string[] = [];
  const recorder = createScreenRecorder('a', api, (m) => messages.push(m), {
    probe: async () => 7000,
    encode,
  });
  await recorder.start();
  expect(Recorder.instances[0]!.options.videoBitsPerSecond).toBe(1_500_000);
  expect(messages.at(-1)).toContain('720p (fast network)');
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.advanceTimersByTimeAsync(30_000);
  // Four segments waiting behind one never-finishing upload: exactly one in flight.
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(1);
  expect(api.uploadRecordingChunk).toHaveBeenCalledWith('a', 0, 'AAAA');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(Recorder.instances[4]!.options.videoBitsPerSecond).toBe(600_000);
  expect(messages.at(-1)).toContain('540p (good network)');
  expect(messages.at(-1)).toContain('4 waiting');
  recorder.stop();
});

it('reports uploads and keeps the exam path free of awaited work', async () => {
  const api = cloudApi(async () => {});
  const messages: string[] = [];
  const recorder = createScreenRecorder('a', api, (m) => messages.push(m), {
    probe: async () => 3000,
    encode,
  });
  await recorder.start();
  expect(Recorder.instances[0]!.options.videoBitsPerSecond).toBe(600_000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(2);
  expect(messages.at(-1)).toBe('Recording • 540p (good network) • uploaded 2/2');
  recorder.stop();
});

it('falls back to local-only after three failed uploads and saves pending segments', async () => {
  const api = cloudApi(async () => {
    throw new Error('network');
  });
  const messages: string[] = [];
  const recorder = createScreenRecorder('a', api, (m) => messages.push(m), {
    probe: async () => 3000,
    encode,
  });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(14_000);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(3);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(messages.at(-1)).toContain('saved on your computer');
  await vi.advanceTimersByTimeAsync(6_000);
  // Later segments are saved locally and no more uploads are attempted.
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(3);
  expect(Recorder.instances.at(-1)!.options.videoBitsPerSecond).toBe(250_000);
  recorder.stop();
});

it('switches to local-only at once when the server says cloud recording is unavailable', async () => {
  const api = cloudApi(async () => {
    throw new ExamApiError({ code: 'invalid_state', message: 'x' }, 503);
  });
  const recorder = createScreenRecorder('a', api, () => {}, {
    probe: async () => 9000,
    encode,
  });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(10_500);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(1);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  recorder.stop();
});

it('records locally when the network probe fails', async () => {
  const api = cloudApi(async () => {});
  const recorder = createScreenRecorder('a', api, () => {}, { probe: async () => null, encode });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.uploadRecordingChunk).not.toHaveBeenCalled();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  recorder.stop();
});

it('steps up one profile after two quiet minutes when a re-probe shows headroom', async () => {
  const api = cloudApi(async () => {});
  const probe = vi.fn(async () => 3000);
  const recorder = createScreenRecorder('a', api, () => {}, { probe, encode });
  await recorder.start();
  probe.mockResolvedValue(9000);
  await vi.advanceTimersByTimeAsync(141_000);
  expect(Recorder.instances.at(-1)!.options.videoBitsPerSecond).toBe(1_500_000);
  recorder.stop();
});
