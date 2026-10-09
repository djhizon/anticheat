// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  WholeScreenRequiredError,
  createScreenRecorder,
  dataUrlToBase64,
  displayMediaRequest,
  isWholeScreen,
} from './screenRecorder.js';
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
  await vi.advanceTimersByTimeAsync(400);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  expect(speedtest).not.toHaveBeenCalled();
  expect(uploadRecordingChunk).not.toHaveBeenCalled();
  expect(video.stop).toHaveBeenCalled();
  expect(mic.stop).toHaveBeenCalled();
});
it('with "keep recordings on this computer" it never probes or uploads even with an API', async () => {
  const api = {
    uploadRecordingChunk: vi.fn(),
    speedtest: vi.fn(),
  } as unknown as ExamApi & { uploadRecordingChunk: ReturnType<typeof vi.fn> };
  const probe = vi.fn(async () => 50_000);
  const status = vi.fn();
  const recorder = createScreenRecorder('a', api, status, { probe, localOnly: true });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(probe).not.toHaveBeenCalled();
  expect(api.uploadRecordingChunk).not.toHaveBeenCalled();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(status).toHaveBeenLastCalledWith(expect.stringContaining('stay on this computer'));
  recorder.stop();
  await vi.advanceTimersByTimeAsync(400);
  expect(api.uploadRecordingChunk).not.toHaveBeenCalled();
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
  let inFlight = 0;
  let maxInFlight = 0;
  const api = cloudApi(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    inFlight -= 1;
  });
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
  // Uploads slower than the segment length pile up, but only one is ever in flight.
  expect(maxInFlight).toBe(1);
  expect(api.uploadRecordingChunk).toHaveBeenCalledWith('a', 0, 'AAAA');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(Recorder.instances[4]!.options.videoBitsPerSecond).toBe(600_000);
  expect(messages.at(-1)).toContain('540p (good network)');
  expect(messages.at(-1)).toContain('waiting');
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

it('steps up from recent segment upload timings without sending probe traffic', async () => {
  const api = cloudApi(() => new Promise((resolve) => setTimeout(resolve, 100)));
  const probe = vi.fn(async () => 3000);
  const recorder = createScreenRecorder('a', api, () => {}, {
    probe,
    // 4 MB of base64 in 100 ms is far above the fastest profile threshold.
    encode: async () => 'A'.repeat(4_000_000),
  });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(141_000);
  expect(Recorder.instances.at(-1)!.options.videoBitsPerSecond).toBe(1_500_000);
  expect(probe).toHaveBeenCalledTimes(1); // only the initial probe
  recorder.stop();
});

it('counts a hung upload as a failure after the timeout and then saves locally', async () => {
  const api = cloudApi(() => new Promise<void>(() => {}));
  const messages: string[] = [];
  const recorder = createScreenRecorder('a', api, (m) => messages.push(m), {
    probe: async () => 3000,
    encode,
  });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14_000);
  expect(URL.createObjectURL).not.toHaveBeenCalled(); // 15 s has not elapsed yet
  await vi.advanceTimersByTimeAsync(2_000);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(1); // retry waits 2 s
  await vi.advanceTimersByTimeAsync(40_000);
  expect(api.uploadRecordingChunk.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(messages.some((m) => m.includes('saved on your computer'))).toBe(true);
  expect(URL.createObjectURL).toHaveBeenCalled();
  recorder.stop();
});

it('recovers to cloud upload two minutes after a network blip', async () => {
  let failing = true;
  const api = cloudApi(async () => {
    if (failing) throw new Error('blip');
  });
  const probe = vi.fn(async () => 3000);
  const recorder = createScreenRecorder('a', api, () => {}, { probe, encode });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(14_000);
  expect(api.uploadRecordingChunk).toHaveBeenCalledTimes(3);
  const callsAtOutage = api.uploadRecordingChunk.mock.calls.length;
  failing = false;
  await vi.advanceTimersByTimeAsync(121_000);
  expect(probe).toHaveBeenCalledTimes(2); // initial + one re-probe
  await vi.advanceTimersByTimeAsync(11_000);
  expect(api.uploadRecordingChunk.mock.calls.length).toBeGreaterThan(callsAtOutage);
  expect(Recorder.instances.at(-1)!.options.videoBitsPerSecond).toBe(600_000);
  recorder.stop();
});

it('does not resume cloud upload after a fatal server refusal', async () => {
  const api = cloudApi(async () => {
    throw new ExamApiError({ code: 'invalid_state', message: 'x' }, 503);
  });
  const probe = vi.fn(async () => 9000);
  const recorder = createScreenRecorder('a', api, () => {}, { probe, encode });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(probe).toHaveBeenCalledTimes(1);
  recorder.stop();
});

it('saves local downloads one at a time, about 400 ms apart', async () => {
  const api = cloudApi(() => new Promise<void>(() => {}));
  const recorder = createScreenRecorder('a', api, () => {}, { probe: async () => 3000, encode });
  await recorder.start();
  // Hung uploads build a backlog; the failover then saves several segments together.
  for (let i = 0; i < 1000 && vi.mocked(URL.createObjectURL).mock.calls.length === 0; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(399);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  recorder.stop();
});

it('asks for the whole screen and refuses a shared window or browser tab', async () => {
  for (const surface of ['window', 'browser']) {
    const shared = Object.assign(new Track(), {
      getSettings: () => ({ displaySurface: surface }),
    });
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockResolvedValueOnce(
      new Stream([shared]) as unknown as MediaStream,
    );
    const recorder = createScreenRecorder('a');
    await expect(recorder.start()).rejects.toBeInstanceOf(WholeScreenRequiredError);
    expect(shared.stop).toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  }
  expect(Recorder.instances).toHaveLength(0);
  const request = vi.mocked(navigator.mediaDevices.getDisplayMedia).mock.calls[0]![0] as {
    video: { displaySurface?: string };
    selfBrowserSurface?: string;
  };
  expect(request.video.displaySurface).toBe('monitor');
  expect(request.selfBrowserSurface).toBe('exclude');
});

it('calls getDisplayMedia synchronously from start() (inside the click activation)', async () => {
  const recorder = createScreenRecorder('a', undefined, () => {}, { desktop: true });
  const pending = recorder.start();
  expect(vi.mocked(navigator.mediaDevices.getDisplayMedia)).toHaveBeenCalledTimes(1);
  await pending;
  recorder.stop();
});

it('explains a refused desktop capture with the macOS Screen Recording reset steps', async () => {
  const refused = Object.assign(new Error('Invalid capture constraints'), {
    name: 'NotAllowedError',
  });
  vi.mocked(navigator.mediaDevices.getDisplayMedia).mockRejectedValueOnce(refused);
  Object.assign(window, {
    electronExam: {
      getScreenCaptureDiagnosis: async () => ({ permission: 'denied', lastRefusal: 'permission' }),
    },
  });
  try {
    const recorder = createScreenRecorder('a', undefined, () => {}, { desktop: true });
    await expect(recorder.start()).rejects.toThrow(/macOS is not letting this app record/u);
    // A browser keeps its own wording for the same DOMException.
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockRejectedValueOnce(refused);
    const web = createScreenRecorder('a', undefined, () => {}, { desktop: false });
    await expect(web.start()).rejects.toThrow(/cancelled or denied/u);
  } finally {
    Reflect.deleteProperty(window, 'electronExam');
  }
});

it('never sends size or frame-rate capture constraints (the desktop app rejects them)', async () => {
  expect(displayMediaRequest(true)).toEqual({ video: true, audio: false });
  const browser = displayMediaRequest(false) as { video: Record<string, unknown> };
  expect(browser.video).toEqual({ displaySurface: 'monitor' });

  // Desktop: plain request and no applyConstraints on the capture track at all.
  const applyConstraints = vi.fn(async () => {
    throw Object.assign(new Error('invalid capture constraints'), {
      name: 'OverconstrainedError',
    });
  });
  const screenTrack = Object.assign(new Track(), { applyConstraints });
  vi.mocked(navigator.mediaDevices.getDisplayMedia).mockResolvedValueOnce(
    new Stream([screenTrack]) as unknown as MediaStream,
  );
  const desktop = createScreenRecorder('a', undefined, () => {}, { desktop: true });
  await desktop.start();
  expect(vi.mocked(navigator.mediaDevices.getDisplayMedia)).toHaveBeenLastCalledWith({
    video: true,
    audio: false,
  });
  expect(applyConstraints).not.toHaveBeenCalled();
  expect(Recorder.instances).toHaveLength(1);
  desktop.stop();

  // Browser: a rejected resize is ignored and recording keeps going.
  const browserTrack = Object.assign(new Track(), { applyConstraints });
  vi.mocked(navigator.mediaDevices.getDisplayMedia).mockResolvedValueOnce(
    new Stream([browserTrack]) as unknown as MediaStream,
  );
  const web = createScreenRecorder('a', undefined, () => {}, { desktop: false });
  await web.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(applyConstraints).toHaveBeenCalled();
  expect(Recorder.instances).toHaveLength(2);
  expect(Recorder.instances[1]!.state).toBe('recording');
  web.stop();
});

it('strips the data-URL header even when the MIME type contains a comma', () => {
  expect(dataUrlToBase64('data:video/webm;codecs=vp8,opus;base64,GkXfo59C')).toBe('GkXfo59C');
  expect(dataUrlToBase64('data:video/webm;base64,GkXfo59C')).toBe('GkXfo59C');
});

it('accepts a whole monitor and browsers that do not report the surface', () => {
  const monitor = { getSettings: () => ({ displaySurface: 'monitor' }) } as MediaStreamTrack;
  const unreported = { getSettings: () => ({}) } as MediaStreamTrack;
  const tab = { getSettings: () => ({ displaySurface: 'browser' }) } as MediaStreamTrack;
  expect(isWholeScreen(monitor)).toBe(true);
  expect(isWholeScreen(unreported)).toBe(true);
  expect(isWholeScreen(tab)).toBe(false);
  expect(isWholeScreen(undefined)).toBe(false);
});

it('reports an unexpected end once and continues segment numbering when resumed', async () => {
  const onEnded = vi.fn();
  const indexes: number[] = [];
  const recorder = createScreenRecorder('a', undefined, () => {}, {
    firstIndex: 7,
    onEnded,
    onSegmentIndex: (next) => indexes.push(next),
  });
  await recorder.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(indexes).toEqual([8]);
  video.dispatchEvent(new Event('ended'));
  expect(onEnded).toHaveBeenCalledOnce();
  expect(onEnded.mock.calls[0]![0]).toContain('Screen sharing ended');
  recorder.stop();
  expect(onEnded).toHaveBeenCalledOnce();
});

it('finish() waits for the last segment before resolving', async () => {
  const recorder = createScreenRecorder('a');
  await recorder.start();
  const done = recorder.finish(1000);
  await vi.advanceTimersByTimeAsync(200);
  await done;
  expect(URL.createObjectURL).toHaveBeenCalledOnce(); // the final local segment was saved
});
