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
  it('starts a new complete recording only after the previous upload finishes', async () => {
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
    expect(Recorder.instances[0]?.start).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(postAudio).toHaveBeenCalledOnce());
    expect(Recorder.instances).toHaveLength(1);
    expect(Buffer.from(postAudio.mock.calls[0]![1] as string, 'base64').toString()).toBe(
      'complete-container-1',
    );
    finish({ transcript: 'test speech' });
    await vi.waitFor(() => expect(Recorder.instances).toHaveLength(2));
    expect(transcript).toHaveBeenCalledWith('test speech');
    session.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(postAudio).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
  });
  it('shows an upload failure instead of silently continuing an empty transcript', async () => {
    const status = vi.fn();
    const postAudio = vi.fn(async () => {
      throw new Error('503');
    });
    const session = createAudioRecorder('a', { postAudio } as unknown as ExamApi, vi.fn(), status);
    await session.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(trackStop).toHaveBeenCalledOnce());
    expect(status.mock.calls.at(-1)?.[0]).toContain('Transcription failed');
    expect(Recorder.instances).toHaveLength(1);
  });
});
