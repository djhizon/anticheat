import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioRecorder } from './audioRecorder.js';
import type { ExamApi } from '../exam/api.js';
vi.mock('./builtInMicrophone.js', () => ({
  acquireBuiltInMicrophone: () =>
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: 'mac' } } }),
}));

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  number = Recorder.instances.length + 1;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  constructor() {
    Recorder.instances.push(this);
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([`complete-container-${this.number}`]) });
    this.onstop?.();
  }
}
class Reader {
  result = '';
  onload: (() => void) | null = null;
  async readAsDataURL(blob: Blob) {
    this.result = `data:audio/webm;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onload?.();
  }
}

describe('independent speech clips', () => {
  const trackStop = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    Recorder.instances = [];
    vi.clearAllMocks();
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('FileReader', Reader);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })),
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('records continuously in 3 s clips and skips a clip while one is in flight', async () => {
    let finish!: (body: { transcript: string }) => void;
    const postAudio = vi.fn(
      (_id: string, _audio: string, _duration: number) =>
        new Promise<{ transcript: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const transcript = vi.fn();
    const skipped = vi.fn();
    const busy = vi.fn();
    const session = createAudioRecorder(
      'a',
      { postAudio } as unknown as ExamApi,
      transcript,
      vi.fn(),
      { onSkipped: skipped, onBusy: busy },
    );
    await session.start();
    expect(Recorder.instances[0]?.start).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(postAudio).toHaveBeenCalledOnce());
    // The next complete recording starts immediately, without waiting for the upload.
    expect(Recorder.instances).toHaveLength(2);
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(Buffer.from(postAudio.mock.calls[0]![1] as string, 'base64').toString()).toBe(
      'complete-container-1',
    );
    expect(postAudio.mock.calls[0]![2]).toBe(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(skipped).toHaveBeenCalledOnce();
    expect(postAudio).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(3);
    finish({ transcript: ' test speech ' });
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    expect(transcript).toHaveBeenCalledWith('test speech', expect.any(Number));
    expect(busy).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(postAudio).toHaveBeenCalledTimes(2));
    session.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(postAudio).toHaveBeenCalledTimes(2);
    expect(trackStop).toHaveBeenCalledOnce();
  });
  it('does not report empty or silent results', async () => {
    const postAudio = vi.fn(async () => ({ transcript: '   ' }));
    const transcript = vi.fn();
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, transcript);
    await session.start();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(postAudio).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    expect(transcript).not.toHaveBeenCalled();
    session.stop();
  });
  it('shows an upload failure instead of silently continuing an empty transcript', async () => {
    const status = vi.fn();
    const postAudio = vi.fn(async () => {
      throw new Error('503');
    });
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, vi.fn(), status);
    await session.start();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalledOnce());
    expect(status.mock.calls.at(-1)?.[0]).toContain('Transcription failed');
    expect(status.mock.calls.at(-1)?.[0]).toContain('Stop and start audio');
  });
  it('flush() uploads the clip in progress and waits for it, bounded', async () => {
    let finish!: (body: { transcript: string }) => void;
    const postAudio = vi.fn(
      (_id: string, _audio: string, _duration: number) =>
        new Promise<{ transcript: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const transcript = vi.fn();
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, transcript);
    await session.start();
    await vi.advanceTimersByTimeAsync(2000); // 2 s into the first clip
    let done = false;
    const flushing = session.flush(3000).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(postAudio).toHaveBeenCalledOnce());
    expect(Recorder.instances).toHaveLength(1); // no new clip is started
    expect(postAudio.mock.calls[0]![2]).toBe(2000);
    expect(done).toBe(false);
    finish({ transcript: 'last words' });
    await flushing;
    expect(transcript).toHaveBeenCalledWith('last words', expect.any(Number));
    session.stop();
  });
  it('flush() gives up after the bound when the upload hangs', async () => {
    const postAudio = vi.fn(() => new Promise<{ transcript: string }>(() => {}));
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, vi.fn());
    await session.start();
    await vi.advanceTimersByTimeAsync(2000);
    const flushing = session.flush(3000);
    await vi.advanceTimersByTimeAsync(3001);
    await flushing;
    expect(postAudio).toHaveBeenCalledOnce();
    session.stop();
  });
  it('flush() skips a final clip too short to transcribe', async () => {
    const postAudio = vi.fn(async () => ({ transcript: 'x' }));
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, vi.fn());
    await session.start();
    await vi.advanceTimersByTimeAsync(300);
    await session.flush(3000);
    expect(postAudio).not.toHaveBeenCalled();
    session.stop();
  });
});
