import {
  parseDetections,
  type Rect,
  type ViewKind,
  type WearableDetection,
} from './wearablesCore.js';

/** Browser fallback model and its input size (D-FINE-S Objects365, dynamic uint8). */
export const BROWSER_WEARABLES_MODEL = {
  id: 'dfine-s-obj365-uint8',
  url: '/vision/models/dfine_s_obj365_uint8.onnx',
  inputSize: 512,
} as const;

/** Main thread -> wearables worker. */
export type WearablesWorkerRequest =
  | { readonly type: 'init'; readonly modelUrl: string; readonly inputSize: number }
  | {
      readonly type: 'detect';
      readonly id: number;
      readonly bitmap: ImageBitmap;
      readonly view: ViewKind;
      /** Normalised region of the bitmap to look at (the whole frame for the 'full' view). */
      readonly crop: Rect;
    };

/** Wearables worker -> main thread. Detections are in crop coordinates. */
export type WearablesWorkerReply =
  | { readonly type: 'ready'; readonly model: string }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly detections: readonly WearableDetection[];
      readonly inferenceMs: number;
    }
  | { readonly type: 'error'; readonly id?: number; readonly message: string };

const isRect = (value: unknown): value is Rect => {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, w, h } = value as Record<string, unknown>;
  return (
    [x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (w as number) > 0 &&
    (h as number) > 0 &&
    (x as number) >= 0 &&
    (y as number) >= 0 &&
    (x as number) + (w as number) <= 1.000001 &&
    (y as number) + (h as number) <= 1.000001
  );
};

/** Worker side: accepts only well-formed requests (anything else is ignored). */
export function parseWorkerRequest(value: unknown): WearablesWorkerRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data.type === 'init') {
    if (typeof data.modelUrl !== 'string' || !data.modelUrl.startsWith('/vision/models/'))
      return null;
    if (typeof data.inputSize !== 'number' || ![320, 416, 512, 640].includes(data.inputSize))
      return null;
    return { type: 'init', modelUrl: data.modelUrl, inputSize: data.inputSize };
  }
  if (data.type === 'detect') {
    if (typeof data.id !== 'number' || !Number.isInteger(data.id)) return null;
    if (data.view !== 'full' && data.view !== 'head') return null;
    if (!isRect(data.crop)) return null;
    if (typeof ImageBitmap === 'undefined' || !(data.bitmap instanceof ImageBitmap)) return null;
    return { type: 'detect', id: data.id, bitmap: data.bitmap, view: data.view, crop: data.crop };
  }
  return null;
}

/** Main-thread side: validates replies before they reach the confirmation logic. */
export function parseWorkerReply(value: unknown): WearablesWorkerReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data.type === 'ready' && typeof data.model === 'string') {
    return { type: 'ready', model: data.model };
  }
  if (data.type === 'error' && typeof data.message === 'string') {
    return typeof data.id === 'number'
      ? { type: 'error', id: data.id, message: data.message }
      : { type: 'error', message: data.message };
  }
  if (
    data.type === 'result' &&
    typeof data.id === 'number' &&
    typeof data.inferenceMs === 'number' &&
    Number.isFinite(data.inferenceMs)
  ) {
    const detections = parseDetections(data.detections);
    if (detections === null) return null;
    return { type: 'result', id: data.id, detections, inferenceMs: data.inferenceMs };
  }
  return null;
}

/** Converts RGBA pixels (row-major, `size` x `size`) to the model's CHW float input in 0..1. */
export function rgbaToChw(rgba: ArrayLike<number>, size: number): Float32Array {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    out[i] = (rgba[i * 4] ?? 0) / 255;
    out[plane + i] = (rgba[i * 4 + 1] ?? 0) / 255;
    out[2 * plane + i] = (rgba[i * 4 + 2] ?? 0) / 255;
  }
  return out;
}
