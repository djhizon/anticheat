import type { ExamApi } from '../exam/api.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';
import { recordingToWavBase64 } from './wavEncoder.js';

/** Short clips keep the transcript feeling live. */
export const CLIP_MS = 3000;
/** A final clip shorter than this is not worth transcribing. */
const MIN_FINAL_CLIP_MS = 1000;

export function createAudioRecorder(
  attemptId: string,
  examApi: ExamApi,
  onTranscript: (text: string, capturedAt: number) => void,
  onStatus: (text: string) => void = () => {},
  hooks: {
    readonly onSkipped?: (capturedAt: number) => void;
    readonly onBusy?: (busy: boolean) => void;
  } = {},
) {
  let inFlight = false;
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let ownsStream = true;
  let upload: AbortController | null = null;
  // flush(): the last clip is cut short and uploaded, and nothing new is started.
  let finishing = false;
  let pending: Promise<void> | null = null;
  let finishedWaiter: (() => void) | null = null;

  function stop() {
    active = false;
    upload?.abort();
    upload = null;
    inFlight = false;
    if (timer) clearTimeout(timer);
    timer = null;
    hooks.onBusy?.(false);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    if (ownsStream) stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
  }

  function capture() {
    if (!active || !stream) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) throw new Error('No supported microphone recording format.');
    const current = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    recorder = current;
    const chunks: Blob[] = [];
    const capturedAt = Date.now();
    current.ondataavailable = (event) => {
      if (active && event.data.size > 0) chunks.push(event.data);
    };
    current.onerror = () => {
      stop();
      onStatus('Transcription recording failed. Restart the audio session.');
    };
    current.onstop = () => {
      if (!active) return;
      // Recording is continuous: the next clip starts at once. Each clip is a
      // complete container; timeslice fragments are not independently decodable.
      if (!finishing) {
        try {
          capture();
        } catch {
          stop();
          onStatus('Transcription recording failed. Restart the audio session.');
          return;
        }
      }
      const clipMs = Math.min(CLIP_MS, Date.now() - capturedAt);
      if (finishing && clipMs < MIN_FINAL_CLIP_MS) {
        // Too short to transcribe: nothing worth sending.
        void Promise.resolve(pending).then(() => finishedWaiter?.());
        return;
      }
      // Backpressure: never queue uploads behind the local model. A clip that
      // finishes while another is in flight is dropped (except the final one,
      // which waits its turn so the end of the exam is not lost).
      if (inFlight && !finishing) {
        hooks.onSkipped?.(capturedAt);
        return;
      }
      const previous = pending;
      const isFinal = finishing;
      inFlight = true;
      hooks.onBusy?.(true);
      const task = (async () => {
        if (previous) await previous.catch(() => {});
        try {
          onStatus('Transcribing the last clip locally…');
          const base64 = await recordingToWavBase64(
            new Blob(chunks, { type: current.mimeType }),
            blobToBase64,
          );
          if (!active) return;
          const controller = new AbortController();
          upload = controller;
          const response = await examApi.postAudio(
            attemptId,
            base64,
            finishing ? clipMs : CLIP_MS,
            controller.signal,
            new Date(capturedAt).toISOString(),
          );
          if (upload === controller) upload = null;
          if (!active) return;
          if (typeof response?.transcript !== 'string')
            throw new Error('Invalid transcription response');
          if (response.transcript.trim()) {
            onTranscript(response.transcript.trim(), capturedAt);
            onStatus('Listening…');
          } else {
            onStatus('Listening… (no speech in the last clip)');
          }
        } catch (error) {
          if (active) {
            stop();
            onStatus(
              `Transcription failed. ${error instanceof Error ? error.message : 'Check the local server.'} Stop and start audio to retry.`,
            );
          }
        } finally {
          inFlight = false;
          if (active) hooks.onBusy?.(false);
        }
      })();
      pending = task;
      void task.finally(() => {
        if (pending === task) pending = null;
        if (isFinal) finishedWaiter?.();
      });
    };
    current.start();
    timer = setTimeout(() => {
      if (active && current.state !== 'inactive') current.stop();
    }, CLIP_MS);
  }

  /**
   * Ends the current clip now and uploads it, waiting (at most `maxMs`) for it and any
   * clip already uploading. Call before submit so the last seconds of audio are kept;
   * `stop()` afterwards releases everything.
   */
  async function flush(maxMs = 3000): Promise<void> {
    if (!active || finishing) return;
    finishing = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const done = new Promise<void>((resolve) => {
      finishedWaiter = resolve;
    });
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else if (pending === null) return;
    else void pending.finally(() => finishedWaiter?.());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, maxMs);
      }),
    ]);
    clearTimeout(timeout);
  }

  async function start(shared?: MediaStream) {
    if (active) return;
    active = true;
    try {
      ownsStream = !shared;
      const acquired = shared ?? (await acquireBuiltInMicrophone());
      if (!active) {
        if (ownsStream) acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      capture();
      onStatus('Listening…');
    } catch (error) {
      stop();
      onStatus('Microphone recording is unavailable for transcription.');
      throw error;
    }
  }
  return { start, stop, flush };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
