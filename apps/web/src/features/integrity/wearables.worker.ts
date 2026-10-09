// Browser fallback for the wearables check: D-FINE-S (Objects365) on onnxruntime-web's WASM
// backend, single-threaded (the page is not cross-origin isolated, and the worker CSP forbids
// nested workers). It runs a few seconds apart from the main face/phone loop in its own worker,
// so it never slows that loop down. Images never leave the device.
import * as ort from 'onnxruntime-web/wasm';

import { decodeDetections, O365_LABEL_COUNT } from './wearablesCore.js';
import { parseWorkerRequest, rgbaToChw, type WearablesWorkerReply } from './wearablesProtocol.js';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: WearablesWorkerReply): void;
};

let session: ort.InferenceSession | null = null;
let inputSize = 640;
let busy = false;

/** Where `npm run vision:prepare` puts onnxruntime-web's runtime (see scripts/vision-assets.json). */
const ORT_WASM_URL = '/vision/ort/ort-wasm-simd-threaded.wasm';

async function initialize(modelUrl: string, size: number): Promise<void> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  // Only the .wasm is overridden: the JS loader stays the one bundled into onnxruntime-web, so
  // nothing is dynamically imported from outside the worker bundle (the dev server would refuse).
  ort.env.wasm.wasmPaths = { wasm: new URL(ORT_WASM_URL, self.location.href).href };
  inputSize = size;
  // Fetch explicitly so a missing model fails fast with a clear status (no remote fallback).
  const response = await fetch(modelUrl, { cache: 'force-cache', redirect: 'error' });
  if (!response.ok) throw new Error(`Model unavailable (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

async function detect(
  id: number,
  bitmap: ImageBitmap,
  crop: { x: number; y: number; w: number; h: number },
): Promise<void> {
  if (session === null) throw new Error('Model not loaded');
  const size = inputSize;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('Canvas unavailable');
  context.imageSmoothingQuality = 'high';
  // D-FINE was trained on plain (non-letterboxed) resizes, so the crop is stretched to a square.
  context.drawImage(
    bitmap,
    crop.x * bitmap.width,
    crop.y * bitmap.height,
    crop.w * bitmap.width,
    crop.h * bitmap.height,
    0,
    0,
    size,
    size,
  );
  const pixels = context.getImageData(0, 0, size, size).data;
  const input = new ort.Tensor('float32', rgbaToChw(pixels, size), [1, 3, size, size]);
  const started = performance.now();
  const outputs = await session.run({ [session.inputNames[0] ?? 'pixel_values']: input });
  const inferenceMs = Math.round(performance.now() - started);
  const logits = outputs.logits;
  const boxes = outputs.pred_boxes;
  if (!logits || !boxes) throw new Error('Unexpected model outputs');
  const queries = logits.dims[1] ?? 0;
  const labels = logits.dims[2] ?? O365_LABEL_COUNT;
  const detections = decodeDetections(
    logits.data as Float32Array,
    boxes.data as Float32Array,
    queries,
    labels,
  );
  worker.postMessage({ type: 'result', id, detections, inferenceMs });
}

worker.onmessage = (event: MessageEvent) => {
  const request = parseWorkerRequest(event.data);
  if (request === null) {
    const bitmap = (event.data as { bitmap?: unknown } | null)?.bitmap;
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close();
    return;
  }
  if (request.type === 'init') {
    if (session !== null || busy) return;
    busy = true;
    void initialize(request.modelUrl, request.inputSize).then(
      () => {
        busy = false;
        worker.postMessage({ type: 'ready', model: request.modelUrl.split('/').pop() ?? '' });
      },
      (error: unknown) => {
        busy = false;
        worker.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Model failed to load',
        });
      },
    );
    return;
  }
  const { id, bitmap, crop } = request;
  if (busy) {
    bitmap.close();
    worker.postMessage({ type: 'error', id, message: 'Busy' });
    return;
  }
  busy = true;
  void detect(id, bitmap, crop)
    .catch((error: unknown) =>
      worker.postMessage({
        type: 'error',
        id,
        message: error instanceof Error ? error.message : 'Detection failed',
      }),
    )
    .finally(() => {
      busy = false;
      bitmap.close();
    });
};
