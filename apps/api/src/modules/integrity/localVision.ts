import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  decodeDetections,
  type WearableDetection,
} from '../../../../web/src/features/integrity/wearablesCore.js';

/**
 * The desktop app's on-device detector (wearables, phone, notes, people). It runs a D-FINE
 * Objects365 model with onnxruntime-node in a worker thread of the local API, which only listens
 * on 127.0.0.1. Frames arrive as 640x640 JPEG views from the student's own browser window and
 * are never stored or forwarded. See docs/LOCAL_AI.md for the model choice and benchmarks.
 */

/** Selectable with VISION_MODEL. All share Objects365's label set. Apache-2.0 weights. */
export const LOCAL_VISION_MODELS = {
  'dfine-x': { file: 'dfine_x_obj365.onnx', name: 'D-FINE-X Objects365' },
  'dfine-l': { file: 'dfine_l_obj365.onnx', name: 'D-FINE-L Objects365' },
  'dfine-m': { file: 'dfine_m_obj365.onnx', name: 'D-FINE-M Objects365' },
  'dfine-s': { file: 'dfine_s_obj365.onnx', name: 'D-FINE-S Objects365' },
} as const;
export type LocalVisionModelId = keyof typeof LOCAL_VISION_MODELS;

export function isLocalVisionModelId(value: string): value is LocalVisionModelId {
  return Object.hasOwn(LOCAL_VISION_MODELS, value);
}

export interface LocalVisionResult {
  readonly model: string;
  readonly inferenceMs: number;
  /** Detections in the coordinates of the submitted view. */
  readonly detections: readonly WearableDetection[];
}

export interface LocalVisionStatus {
  readonly available: boolean;
  readonly model: string | null;
}

export interface LocalVisionDetector {
  status(): LocalVisionStatus;
  detect(jpeg: Uint8Array): Promise<LocalVisionResult>;
  stop(): void;
}

export class LocalVisionBusyError extends Error {}

/** Minimal worker surface so tests can drive the service without a real model. */
export interface VisionWorkerLike {
  postMessage(value: unknown, transfer?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error' | 'exit', listener: (value: unknown) => void): unknown;
  terminate(): unknown;
}

/** Replaced by `true` when esbuild bundles the API for the desktop app. */
declare const __DESKTOP_BUNDLE__: boolean | undefined;

function defaultWorkerUrl(): URL {
  return typeof __DESKTOP_BUNDLE__ !== 'undefined' && __DESKTOP_BUNDLE__
    ? new URL('./local-vision.worker.mjs', import.meta.url)
    : new URL('./localVision.worker.ts', import.meta.url);
}

export function defaultModelDir(): string {
  return fileURLToPath(new URL('../../../vendor/vision-models/', import.meta.url));
}

/** Half the logical cores (at least 2): fast enough, and the exam UI keeps headroom. */
export function inferenceThreads(cores: number = availableParallelism()): number {
  return Math.max(2, Math.floor(cores / 2));
}

interface Pending {
  readonly id: number;
  readonly jpeg: Uint8Array;
  readonly resolve: (value: LocalVisionResult) => void;
  readonly reject: (error: Error) => void;
}

export function createLocalVision(options: {
  readonly modelId: string;
  readonly modelDir?: string | undefined;
  readonly threads?: number;
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
  readonly spawn?: (url: URL) => VisionWorkerLike;
  readonly fileExists?: (path: string) => boolean;
}): LocalVisionDetector {
  const modelId: LocalVisionModelId = isLocalVisionModelId(options.modelId)
    ? options.modelId
    : 'dfine-x';
  const spec = LOCAL_VISION_MODELS[modelId];
  const modelPath = join(options.modelDir ?? defaultModelDir(), spec.file);
  const fileExists = options.fileExists ?? existsSync;
  const maxQueued = options.maxQueued ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const spawn =
    options.spawn ??
    ((url: URL) => new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: 512 } }));

  let worker: VisionWorkerLike | null = null;
  let ready = false;
  let failed = false;
  let nextId = 1;
  let inFlight: (Pending & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const queue: Pending[] = [];

  function failAll(error: Error): void {
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight.reject(error);
      inFlight = null;
    }
    for (const item of queue.splice(0)) item.reject(error);
  }

  function shutdown(error: Error, permanent: boolean): void {
    const current = worker;
    worker = null;
    ready = false;
    if (permanent) failed = true;
    void current?.terminate();
    failAll(error);
  }

  function pump(): void {
    if (!ready || worker === null || inFlight !== null) return;
    const next = queue.shift();
    if (!next) return;
    const timer = setTimeout(
      // A stuck run leaves the worker unusable; restart it on the next request.
      () => shutdown(new Error('Local detection timed out.'), false),
      timeoutMs,
    );
    inFlight = { ...next, timer };
    // A Node Buffer is often a view into a shared pool; transferring its ArrayBuffer throws
    // DataCloneError and kills the server. Copy into a fresh, exactly-sized buffer first.
    const copy = toTransferable(next.jpeg);
    worker.postMessage({ type: 'run', id: next.id, jpeg: copy }, [copy.buffer]);
  }

  function onMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
      ready = true;
      pump();
      return;
    }
    if (message.type === 'error' && message.id === undefined) {
      console.warn('[local-vision] model failed to load:', String(message.message));
      shutdown(new Error('Local detector unavailable.'), true);
      return;
    }
    const current = inFlight;
    if (current === null || message.id !== current.id) return;
    clearTimeout(current.timer);
    inFlight = null;
    if (message.type === 'error') {
      current.reject(new Error(String(message.message)));
    } else if (
      message.type === 'result' &&
      message.logits instanceof Float32Array &&
      message.boxes instanceof Float32Array &&
      typeof message.queries === 'number' &&
      typeof message.labels === 'number' &&
      typeof message.inferenceMs === 'number'
    ) {
      current.resolve({
        model: modelId,
        inferenceMs: message.inferenceMs,
        detections: decodeDetections(
          message.logits,
          message.boxes,
          message.queries,
          message.labels,
        ),
      });
    } else {
      current.reject(new Error('Malformed detector output.'));
    }
    pump();
  }

  function start(): VisionWorkerLike {
    if (worker) return worker;
    const created = spawn(defaultWorkerUrl());
    worker = created;
    created.on('message', onMessage);
    created.on('error', (error) => {
      if (worker !== created) return;
      console.warn('[local-vision] worker error:', error instanceof Error ? error.message : error);
      shutdown(new Error('Local detector unavailable.'), true);
    });
    created.on('exit', () => {
      if (worker === created) shutdown(new Error('Local detector stopped.'), false);
    });
    created.postMessage({
      type: 'init',
      modelPath,
      threads: options.threads ?? inferenceThreads(),
    });
    return created;
  }

  return {
    status(): LocalVisionStatus {
      const available = !failed && fileExists(modelPath);
      // Warm up on the first status call so the model is loaded before the first frame.
      if (available) start();
      return { available, model: available ? modelId : null };
    },
    detect(jpeg: Uint8Array): Promise<LocalVisionResult> {
      if (failed || !fileExists(modelPath)) {
        return Promise.reject(new Error('Local detector unavailable.'));
      }
      if (queue.length >= maxQueued) return Promise.reject(new LocalVisionBusyError('Busy.'));
      start();
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, jpeg, resolve, reject });
        pump();
      });
    },
    stop(): void {
      shutdown(new Error('Local detector stopped.'), false);
    },
  };
}

/** A standalone copy whose ArrayBuffer is exactly its bytes, so it can be transferred safely. */
export function toTransferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
