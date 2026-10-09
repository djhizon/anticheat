import type { HeadPose, VisionObservation, VisionReply } from './visionSignals.js';

const POSE_TIMEOUT_MS = 5000;

/** Races a promise against a timer and always clears the timer afterwards. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface FramePoseSource {
  /** Resolves a head pose for the current video frame, or null when no single face is found. */
  pose(): Promise<HeadPose | null>;
  /** Full observation for the current frame (face count and box), or null if none came back. */
  observe(): Promise<VisionObservation | null>;
  close(): void;
}

/** Runs the app's existing MediaPipe face-landmarker worker over camera frames. */
export async function createWorkerPoseSource(video: HTMLVideoElement): Promise<FramePoseSource> {
  const url = import.meta.env.DEV
    ? '/src/features/integrity/vision.worker.ts?worker_file&type=module'
    : (await import('./vision.worker.ts?worker&url')).default;
  const worker = new Worker(url, { type: 'module' });
  const next = (): Promise<VisionReply> =>
    new Promise((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<VisionReply>) => resolve(data);
      worker.onerror = () => reject(new Error('Face model failed to load.'));
    });
  const ready = next();
  worker.postMessage({ type: 'init', objects: false });
  try {
    const reply = await withTimeout(ready, 30_000, 'Face model initialization timed out.');
    if (reply.type !== 'ready') throw new Error('Face model unavailable.');
  } catch (error) {
    worker.terminate();
    throw error;
  }
  const observe = async (): Promise<VisionObservation | null> => {
    const bitmap = await createImageBitmap(video);
    const reply = next();
    worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
    const data = await withTimeout(reply, POSE_TIMEOUT_MS, 'Face model stopped responding.');
    return data.type === 'observation' ? data.observation : null;
  };
  return {
    pose: async () => (await observe())?.pose ?? null,
    observe,
    close: () => worker.terminate(),
  };
}
