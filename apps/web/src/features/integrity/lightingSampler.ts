import type { FeedFrame } from './cameraGate.js';

export const LIGHTING_SAMPLE_SIZE = 64;

export interface LightingSample {
  readonly frames: readonly FeedFrame[];
  readonly width: number;
  readonly height: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readLuma(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): Float32Array {
  const size = LIGHTING_SAMPLE_SIZE;
  ctx.drawImage(video, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  for (let i = 0; i < lum.length; i += 1)
    lum[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
  return lum;
}

function makeContext(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  canvas.width = LIGHTING_SAMPLE_SIZE;
  canvas.height = LIGHTING_SAMPLE_SIZE;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * Samples a playing video element: `frames` small luminance frames `gapMs` apart (two or more
 * give a noise estimate). Never throws; an unready or tainted video yields an empty result.
 */
export async function sampleVideoLighting(
  video: HTMLVideoElement,
  frames = 2,
  gapMs = 120,
): Promise<LightingSample | null> {
  try {
    if (video.readyState < 2) return null;
    const ctx = makeContext();
    if (!ctx) return null;
    const out: FeedFrame[] = [];
    for (let k = 0; k < frames; k += 1) {
      if (k > 0) await wait(gapMs);
      out.push(readLuma(video, ctx));
    }
    return { frames: out, width: LIGHTING_SAMPLE_SIZE, height: LIGHTING_SAMPLE_SIZE };
  } catch {
    return null;
  }
}

export interface StreamLightingSampler {
  sample(frames?: number, gapMs?: number): Promise<LightingSample | null>;
  dispose(): void;
}

/** A hidden, muted video bound to a live stream, for callers that do not own a preview element. */
export function createStreamLightingSampler(stream: MediaStream): StreamLightingSampler {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const started = Promise.resolve()
    .then(() => video.play())
    .catch(() => undefined);
  return {
    async sample(frames, gapMs) {
      await started;
      const deadline = Date.now() + 2000;
      while (video.readyState < 2 && Date.now() < deadline) await wait(50);
      return sampleVideoLighting(video, frames, gapMs);
    },
    dispose() {
      video.pause();
      video.srcObject = null;
    },
  };
}
