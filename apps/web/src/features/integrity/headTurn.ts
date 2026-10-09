import type { LivenessTurnDirection, LivenessYawSample } from '@examguard/contracts/exam';

import { acquireUnlessAborted, throwIfAborted } from './livenessCapture.js';
import { acquirePhysicalCamera } from './physicalCamera.js';
import type { HeadPose, VisionObservation, VisionReply } from './visionSignals.js';
import { relativePose } from './visionSignals.js';

/**
 * Sign applied to the helper's yaw so that positive means the student turned
 * to their own right. faceDirection.ts reports positive yaw as "right".
 */
export const YAW_RIGHT_SIGN = 1;
/** A turn is considered done on the device slightly beyond the server's 15 degrees. */
export const DEVICE_TURN_DEG = 20;
const RECENTRE_DEG = 6;
const SAMPLE_MS = 100;
const CALIBRATION_MS = 1200;
const TURN_TIMEOUT_MS = 5000;
const RECENTRE_TIMEOUT_MS = 3000;

const POSE_TIMEOUT_MS = 5000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Yaw relative to the starting pose, positive towards the student's right. */
export function turnYaw(current: HeadPose, baseline: HeadPose): number {
  return relativePose(current, baseline).yaw * YAW_RIGHT_SIGN;
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

export interface HeadTurnEvidence {
  readonly cameraLabel: string;
  readonly samples: readonly LivenessYawSample[];
}

/**
 * Measures head yaw on-device and returns timestamped samples (relative to the
 * student's starting pose) while prompting each requested turn in order.
 */
export async function captureHeadTurn(
  sequence: readonly LivenessTurnDirection[],
  onPrompt: (text: string) => void,
  acquire: () => Promise<MediaStream> = acquirePhysicalCamera,
  openPoseSource: (video: HTMLVideoElement) => Promise<FramePoseSource> = createWorkerPoseSource,
  signal?: AbortSignal,
): Promise<HeadTurnEvidence> {
  const stream = await acquireUnlessAborted(acquire, signal);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let source: FramePoseSource | null = null;
  try {
    const cameraLabel = stream.getVideoTracks()[0]?.label ?? '';
    await video.play();
    onPrompt('Loading the face model on this device…');
    source = await openPoseSource(video);
    throwIfAborted(signal);

    onPrompt('Look straight at the screen.');
    const started = performance.now();
    const samples: LivenessYawSample[] = [];
    const basePoses: HeadPose[] = [];
    while (performance.now() - started < CALIBRATION_MS) {
      throwIfAborted(signal);
      const pose = await source.pose();
      if (pose) basePoses.push(pose);
      await wait(SAMPLE_MS);
    }
    if (basePoses.length < 3) throw new Error('Your face was not clearly visible. Retry.');
    const baseline: HeadPose = {
      yaw: median(basePoses.map((pose) => pose.yaw)),
      pitch: median(basePoses.map((pose) => pose.pitch)),
    };
    const t0 = started;
    const record = async (): Promise<number | null> => {
      throwIfAborted(signal);
      const pose = await source!.pose();
      if (!pose) return null;
      const yaw = turnYaw(pose, baseline);
      samples.push({ t: Math.round(performance.now() - t0), yaw });
      return yaw;
    };
    samples.push({ t: 0, yaw: 0 });

    for (const direction of sequence) {
      const sign = direction === 'right' ? 1 : -1;
      onPrompt(`Turn your head to your ${direction}.`);
      const turnStart = performance.now();
      while (performance.now() - turnStart < TURN_TIMEOUT_MS) {
        const yaw = await record();
        if (yaw !== null && sign * yaw >= DEVICE_TURN_DEG) break;
        await wait(SAMPLE_MS);
      }
      onPrompt('Now face the screen again.');
      const centreStart = performance.now();
      while (performance.now() - centreStart < RECENTRE_TIMEOUT_MS) {
        const yaw = await record();
        if (yaw !== null && Math.abs(yaw) <= RECENTRE_DEG) break;
        await wait(SAMPLE_MS);
      }
    }
    return { cameraLabel, samples };
  } finally {
    source?.close();
    video.srcObject = null;
    stream.getTracks().forEach((track) => track.stop());
  }
}
