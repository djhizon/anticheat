import type { ExamApi } from '../exam/api.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';

/** Short clips keep the transcript feeling live. */
export const CLIP_MS = 3000;

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
      try {
        capture();
      } catch {
        stop();
        onStatus('Transcription recording failed. Restart the audio session.');
        return;
      }
      // Backpressure: never queue uploads behind the local model. A clip that
      // finishes while another is in flight is dropped.
      if (inFlight) {
        hooks.onSkipped?.(capturedAt);
        return;
      }
      inFlight = true;
      hooks.onBusy?.(true);
      void (async () => {
        try {
          onStatus('Transcribing the last clip locally…');
          const base64 = await blobToBase64(new Blob(chunks, { type: current.mimeType }));
          if (!active) return;
          const controller = new AbortController();
          upload = controller;
          const response = await examApi.postAudio(
            attemptId,
            base64,
            CLIP_MS,
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
    };
    current.start();
    timer = setTimeout(() => {
      if (active && current.state !== 'inactive') current.stop();
    }, CLIP_MS);
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
  return { start, stop };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
