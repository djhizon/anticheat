import { afterEach, expect, it, vi } from 'vitest';
import { AUDIO_CONSENT_TEXT, createAudioSession } from './audioSession.js';

it('consent text discloses local Whisper transcription, text-only storage, retention and bystanders', () => {
  expect(AUDIO_CONSENT_TEXT).toMatch(/transcribe/);
  expect(AUDIO_CONSENT_TEXT).toMatch(/on\s+this computer with Whisper/);
  expect(AUDIO_CONSENT_TEXT).toMatch(/Only the text is saved, never the audio/);
  expect(AUDIO_CONSENT_TEXT).toMatch(/report/);
  expect(AUDIO_CONSENT_TEXT).toMatch(/30 days/);
  expect(AUDIO_CONSENT_TEXT).toMatch(/Other people/);
});
const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./builtInMicrophone.js', () => ({ acquireBuiltInMicrophone: mocks.acquire }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('stops a microphone acquired after the session was destroyed', async () => {
  let resolve!: (stream: MediaStream) => void;
  const stop = vi.fn();
  mocks.acquire.mockImplementation(
    () =>
      new Promise<MediaStream>((done) => {
        resolve = done;
      }),
  );
  const publish = vi.fn();
  const session = createAudioSession('a', publish, vi.fn());
  const pending = session.start(true);
  session.destroy();
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await pending;
  expect(stop).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledTimes(1);
});
it('monitors a borrowed stream without capturing or stopping another microphone', async () => {
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      createAnalyser() {
        return { fftSize: 512, getFloatTimeDomainData: (values: Float32Array) => values.fill(0) };
      }
      resume = vi.fn(async () => {});
      close = close;
    },
  );
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const shared = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const session = createAudioSession('a', vi.fn(), vi.fn());
  await session.start(true, shared);
  expect(session.snapshot().phase).toBe('recording');
  session.destroy();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
