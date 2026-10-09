import { acquireBuiltInMicrophone } from './builtInMicrophone.js';
import { readCameraLabel } from './livenessCapture.js';

export const SPOKEN_WORDS_RECORD_MS = 4000;

export interface SpokenWordsEvidence {
  readonly cameraLabel: string;
  readonly audioBase64: string;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Recording could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Records a short clip from the built-in microphone. The native camera label is
 * still read (without showing video) so the native-webcam-only rule holds.
 * The clip is transcribed by the local API; nothing goes to a cloud service.
 */
export async function captureSpokenWords(
  durationMs = SPOKEN_WORDS_RECORD_MS,
  onRecording: () => void = () => {},
): Promise<SpokenWordsEvidence> {
  const cameraLabel = await readCameraLabel();
  const stream = await acquireBuiltInMicrophone();
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) throw new Error('No supported microphone recording format.');
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('Microphone recording failed.'));
    });
    recorder.start();
    onRecording();
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, durationMs);
    await stopped;
    const audioBase64 = await blobToBase64(new Blob(chunks, { type: recorder.mimeType }));
    return { cameraLabel, audioBase64 };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
