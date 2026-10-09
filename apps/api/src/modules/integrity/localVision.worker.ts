// Worker thread of the desktop app's on-device detector. onnxruntime-node runs inference
// synchronously, so it lives here, never on the API's event loop. It receives one JPEG view
// (already cropped and sized by the browser), decodes it, and returns the raw model outputs.
//
// This file runs as-is under Node's built-in type stripping in development and is bundled to
// `local-vision.worker.mjs` for the desktop app, so it uses erasable TypeScript only and imports
// nothing relative.
import { parentPort } from 'node:worker_threads';

import jpeg from 'jpeg-js';

export const INPUT_SIZE = 640;
/** jpeg-js guards against decompression bombs; a 640x640 view needs far less than this. */
const JPEG_LIMITS = { maxResolutionInMP: 4, maxMemoryUsageInMB: 64 };

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** Bilinear resize (plain stretch, as D-FINE was trained) to size x size, CHW floats in 0..1. */
export function toInputTensor(image: RgbaImage, size: number = INPUT_SIZE): Float32Array {
  const { width: w, height: h, data } = image;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < size; y += 1) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / size - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < size; x += 1) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / size - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const dx = fx - x0;
      for (let c = 0; c < 3; c += 1) {
        const a = data[(y0 * w + x0) * 4 + c] ?? 0;
        const b = data[(y0 * w + x1) * 4 + c] ?? 0;
        const d = data[(y1 * w + x0) * 4 + c] ?? 0;
        const e = data[(y1 * w + x1) * 4 + c] ?? 0;
        const top = a + (b - a) * dx;
        const bottom = d + (e - d) * dx;
        out[c * plane + y * size + x] = (top + (bottom - top) * dy) / 255;
      }
    }
  }
  return out;
}

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, ...JPEG_LIMITS });
  if (!(image.width > 0 && image.height > 0)) throw new Error('Empty image');
  return image;
}

type InitMessage = { type: 'init'; modelPath: string; threads: number };
type RunMessage = { type: 'run'; id: number; jpeg: Uint8Array };

async function main(): Promise<void> {
  const port = parentPort;
  if (port === null) return;
  // Loaded lazily so a missing optional dependency is reported, not thrown at import time.
  let ort: typeof import('onnxruntime-node');
  let session: import('onnxruntime-node').InferenceSession | null = null;
  port.on('message', (message: InitMessage | RunMessage) => {
    void (async () => {
      if (message.type === 'init') {
        try {
          ort = await import('onnxruntime-node');
          session = await ort.InferenceSession.create(message.modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
            intraOpNumThreads: message.threads,
            interOpNumThreads: 1,
          });
          port.postMessage({ type: 'ready' });
        } catch (error) {
          port.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : 'Model failed to load',
          });
        }
        return;
      }
      try {
        if (session === null) throw new Error('Model not loaded');
        const input = toInputTensor(decodeJpeg(message.jpeg));
        const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const started = performance.now();
        const outputs = await session.run({ [session.inputNames[0] ?? 'pixel_values']: tensor });
        const inferenceMs = Math.round(performance.now() - started);
        const logits = outputs.logits;
        const boxes = outputs.pred_boxes;
        if (logits === undefined || boxes === undefined) throw new Error('Unexpected outputs');
        const logitsData = Float32Array.from(logits.data as Float32Array);
        const boxesData = Float32Array.from(boxes.data as Float32Array);
        port.postMessage(
          {
            type: 'result',
            id: message.id,
            logits: logitsData,
            boxes: boxesData,
            queries: logits.dims[1],
            labels: logits.dims[2],
            inferenceMs,
          },
          [logitsData.buffer, boxesData.buffer],
        );
      } catch (error) {
        port.postMessage({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? error.message : 'Detection failed',
        });
      }
    })();
  });
}

void main();
