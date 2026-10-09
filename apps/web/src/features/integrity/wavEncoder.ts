/** Sample rate whisper.cpp expects; clips are resampled to this in the browser. */
export const WHISPER_SAMPLE_RATE = 16000;

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodePcm16Wav(
  samples: Float32Array,
  sampleRate: number = WHISPER_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  }
  return out;
}

/**
 * Decodes a recorded clip with Web Audio and resamples it to 16 kHz mono.
 * Returns null when Web Audio is unavailable or the clip cannot be decoded.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array | null> {
  const Context = typeof AudioContext === 'undefined' ? undefined : AudioContext;
  const Offline = typeof OfflineAudioContext === 'undefined' ? undefined : OfflineAudioContext;
  if (!Context || !Offline) return null;
  let context: AudioContext | undefined;
  try {
    context = new Context();
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const length = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
    const offline = new Offline(1, length, WHISPER_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination); // A mono destination down-mixes channels.
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch {
    return null;
  } finally {
    void context?.close().catch(() => {});
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Converts a recording to a 16 kHz mono PCM WAV and returns it as base64 so the
 * server can skip ffmpeg. Falls back to `fallback(blob)` (the raw container) when
 * decoding is not possible; the server then converts with ffmpeg as before.
 */
export async function recordingToWavBase64(
  blob: Blob,
  fallback: (blob: Blob) => Promise<string>,
): Promise<string> {
  const samples = await decodeToMono16k(blob);
  if (!samples || samples.length === 0) return fallback(blob);
  return bytesToBase64(encodePcm16Wav(samples));
}
