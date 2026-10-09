import type { ExamApi } from '../exam/api.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';

export function createAudioRecorder(
  attemptId: string,
  examApi: ExamApi,
  onTranscript: (text: string) => void,
  onStatus: (text: string) => void = () => {},
) {
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
    if (timer) clearTimeout(timer);
    timer = null;
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

  function capture(note = '') {
    if (!active || !stream) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) throw new Error('No supported microphone recording format.');
    const current = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    recorder = current;
    const chunks: Blob[] = [];
    current.ondataavailable = (event) => {
      if (active && event.data.size > 0) chunks.push(event.data);
    };
    current.onerror = () => {
      stop();
      onStatus('Transcription recording failed. Restart the audio session.');
    };
    current.onstop = () => {
      if (!active) return;
      void (async () => {
        try {
          onStatus('Transcribing a 5-second clip locally…');
          // Each recording is complete, including its container header. Timeslice
          // fragments from one long recording are not independently decodable.
          const base64 = await blobToBase64(new Blob(chunks, { type: current.mimeType }));
          if (!active) return;
          upload = new AbortController();
          const started = performance.now();
          const response = await examApi.postAudio(attemptId, base64, 5000, upload.signal);
          upload = null;
          if (!active) return;
          if (typeof response?.transcript !== 'string')
            throw new Error('Invalid transcription response');
          if (response.transcript.trim()) onTranscript(response.transcript);
          // Backpressure: never accumulate uploads behind the local model.
          const elapsed = ((performance.now() - started) / 1000).toFixed(1);
          capture(
            response.transcript.trim()
              ? `Previous clip processed in ${elapsed}s. `
              : `No speech recognized in the last clip (${elapsed}s). `,
          );
        } catch (error) {
          if (active) {
            stop();
            onStatus(
              `Transcription failed. ${error instanceof Error ? error.message : 'Check the local server.'} Stop and start audio to retry.`,
            );
          }
        }
      })();
    };
    current.start();
    onStatus(`${note}Recording a 5-second speech clip…`);
    timer = setTimeout(() => {
      if (active && current.state !== 'inactive') current.stop();
    }, 5000);
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
