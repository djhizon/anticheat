import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { ExamApi } from '../exam/api.js';
import { EVIDENCE_TRIGGER_EVENT } from '../evidence/useEvidenceCapture.js';
import { VISION_WORKER_CSP } from './visionPolicy.js';
import type { VisionObservation } from './visionSignals.js';
import { parseDetections, type Rect, type ViewKind } from './wearablesCore.js';
import {
  createWearablesEngine,
  emptyWearables,
  type WearablesBackend,
  type WearablesSnapshot,
} from './wearablesEngine.js';
import type { FaceKeypoints } from './wearablesGeometry.js';
import { BROWSER_WEARABLES_MODEL, parseWorkerReply } from './wearablesProtocol.js';

/** Keypoints older than this no longer place the head crop. */
const KEYPOINTS_FRESH_MS = 1500;
const LOCAL_INPUT = 640;
const REQUEST_TIMEOUT_MS = 15_000;

export type WearablesApi = Partial<
  Pick<ExamApi, 'getLocalVisionStatus' | 'postLocalVision' | 'patchEvents'>
>;

async function browserBackend(signal: AbortSignal): Promise<WearablesBackend> {
  const url = import.meta.env.DEV
    ? '/src/features/integrity/wearables.worker.ts?worker_file&type=module'
    : (await import('./wearables.worker.ts?worker&url')).default;
  // Same fail-closed policy check as the face/phone worker: no CSP header, no worker.
  const policy = await fetch(url, { method: 'HEAD', cache: 'no-store', redirect: 'error', signal });
  if (!policy.ok || policy.headers.get('content-security-policy') !== VISION_WORKER_CSP) {
    throw new Error('Worker policy unavailable');
  }
  const worker = new Worker(url, { type: 'module' });
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: { detections: never[]; inferenceMs: number }) => void;
      reject: (e: Error) => void;
    }
  >();
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const model = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Model load timed out')), 60_000);
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    worker.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Worker failed'));
    };
    worker.onmessage = ({ data }: MessageEvent) => {
      const reply = parseWorkerReply(data);
      if (reply?.type === 'ready') {
        clearTimeout(timer);
        resolve(BROWSER_WEARABLES_MODEL.id);
      } else if (reply?.type === 'error' && reply.id === undefined) {
        clearTimeout(timer);
        reject(new Error(reply.message));
      }
    };
    worker.postMessage({
      type: 'init',
      modelUrl: BROWSER_WEARABLES_MODEL.url,
      inputSize: BROWSER_WEARABLES_MODEL.inputSize,
    });
  }).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });
  worker.onerror = () => failAll(new Error('Worker failed'));
  worker.onmessage = ({ data }: MessageEvent) => {
    const reply = parseWorkerReply(data);
    if (reply === null || reply.type === 'ready') return;
    const id = reply.id;
    if (id === undefined) return failAll(new Error(reply.type === 'error' ? reply.message : ''));
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (reply.type === 'error') entry.reject(new Error(reply.message));
    else entry.resolve({ detections: reply.detections as never[], inferenceMs: reply.inferenceMs });
  };
  return {
    kind: 'browser',
    model,
    async detect(frame: ImageBitmap, view: ViewKind, crop: Rect) {
      const copy = await createImageBitmap(frame);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Timed out'));
        }, 30_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        worker.postMessage({ type: 'detect', id, bitmap: copy, view, crop }, [copy]);
      });
    },
    close() {
      failAll(new Error('Closed'));
      worker.terminate();
    },
  };
}

/** Crops and resizes one view to the model's input size and encodes it as base64 JPEG. */
async function viewJpeg(frame: ImageBitmap, crop: Rect): Promise<string> {
  const canvas = new OffscreenCanvas(LOCAL_INPUT, LOCAL_INPUT);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas unavailable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    frame,
    crop.x * frame.width,
    crop.y * frame.height,
    crop.w * frame.width,
    crop.h * frame.height,
    0,
    0,
    LOCAL_INPUT,
    LOCAL_INPUT,
  );
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function localBackend(
  api: WearablesApi,
  attemptId: () => string,
  signal: AbortSignal,
): Promise<WearablesBackend | null> {
  const status = api.getLocalVisionStatus;
  const post = api.postLocalVision;
  if (!status || !post) return null;
  const result = await status.call(api, signal).catch(() => null);
  if (result === null || !result.available || result.model === null) return null;
  const closed = new AbortController();
  signal.addEventListener('abort', () => closed.abort(), { once: true });
  return {
    kind: 'local',
    model: result.model,
    async detect(frame: ImageBitmap, view: ViewKind, crop: Rect) {
      const image = await viewJpeg(frame, crop);
      const request = new AbortController();
      const cancel = () => request.abort();
      closed.signal.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
      try {
        const response = await post.call(api, attemptId(), image, view, request.signal);
        const detections = parseDetections(response.detections);
        if (detections === null) throw new Error('Malformed detections');
        return { detections, inferenceMs: response.inferenceMs };
      } finally {
        clearTimeout(timeout);
        closed.signal.removeEventListener('abort', cancel);
      }
    },
    close() {
      closed.abort();
    },
  };
}

/**
 * The on-device wearables check for the camera panel. Runs only while `active`; returns the
 * latest snapshot and an `observe` hook fed with every face-mesh observation (keypoints only).
 */
export function useWearables(options: {
  readonly attemptId: string;
  readonly active: boolean;
  readonly video: RefObject<HTMLVideoElement | null>;
  readonly api: WearablesApi | undefined;
}): { readonly snapshot: WearablesSnapshot; observe(observation: VisionObservation): void } {
  const { attemptId, active, video, api } = options;
  const [snapshot, setSnapshot] = useState<WearablesSnapshot>(emptyWearables);
  const keypoints = useRef<{ value: FaceKeypoints; at: number } | null>(null);
  const attempt = useRef(attemptId);
  attempt.current = attemptId;

  useEffect(() => {
    if (!active) {
      setSnapshot(emptyWearables());
      return;
    }
    const abort = new AbortController();
    const engine = createWearablesEngine({
      async connect(avoidLocal) {
        if (!avoidLocal && api) {
          const local = await localBackend(api, () => attempt.current, abort.signal);
          if (local !== null) return local;
        }
        return browserBackend(abort.signal).catch(() => null);
      },
      async grabFrame() {
        const element = video.current;
        return element && element.readyState >= 2 && element.videoWidth > 0
          ? createImageBitmap(element)
          : null;
      },
      keypoints() {
        const latest = keypoints.current;
        return latest !== null && performance.now() - latest.at <= KEYPOINTS_FRESH_MS
          ? latest.value
          : null;
      },
      now: () => Date.now(),
      setTimer(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      onSnapshot: setSnapshot,
      onEvents(events) {
        const patch = api?.patchEvents;
        for (const event of events) {
          if (patch) void patch.call(api, attempt.current, { event: event.event }).catch(() => {});
          if (event.evidence !== undefined) {
            window.dispatchEvent(
              new CustomEvent(EVIDENCE_TRIGGER_EVENT, {
                detail: { trigger: event.evidence, immediate: true },
              }),
            );
          }
        }
      },
    });
    engine.start();
    return () => {
      abort.abort();
      engine.stop();
    };
  }, [active, attemptId, api, video]);

  const observe = useMemo(
    () => (observation: VisionObservation) => {
      const value = observation.faces === 1 ? (observation.faceKeypoints ?? null) : null;
      keypoints.current = value === null ? null : { value, at: performance.now() };
    },
    [],
  );
  return { snapshot, observe };
}
