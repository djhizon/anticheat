import type { CameraEngine, CameraEnvironment } from './cameraSession.js';
import type { VisionReply } from './visionSignals.js';
import { VISION_WORKER_CSP } from './visionPolicy.js';
import { acquirePhysicalCamera } from './physicalCamera.js';

export function cameraEnvironment(video: HTMLVideoElement, cameraStatus: (label: string) => void = () => {}, objects = false): CameraEnvironment {
  return {
    page: document,
    window,
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
    hidden: () => document.hidden,
    everyTick(callback) {
      const timer = setInterval(callback, 250);
      return () => clearInterval(timer);
    },
    async prepare(signal, observe, fail): Promise<CameraEngine> {
      // Vite's development asset-URL middleware can serve ?worker&url as raw TS.
      // Use its actual module-worker endpoint in dev and its emitted URL in builds.
      const visionWorkerUrl = import.meta.env.DEV
        ? '/src/features/integrity/vision.worker.ts?worker_file&type=module'
        : (await import('./vision.worker.ts?worker&url')).default;
      const policy = await fetch(visionWorkerUrl, {
        method: 'HEAD',
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      // A static host missing these headers must fail closed before any camera access.
      if (
        !policy.ok ||
        policy.headers.get('content-security-policy') !== VISION_WORKER_CSP ||
        signal.aborted
      )
        throw new Error('Worker policy unavailable');
      const worker = new Worker(visionWorkerUrl, { type: 'module' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('Model initialization timed out'));
        }, 30_000);
        const aborted = () => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error('Cancelled'));
        };
        signal.addEventListener('abort', aborted, { once: true });
        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error('Worker failed'));
          fail();
        };
        worker.onmessage = ({ data }: MessageEvent<VisionReply>) => {
          if (signal.aborted) return;
          if (data.type === 'ready') {
            clearTimeout(timer);
            resolve();
          } else if (data.type === 'error') {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error('Models unavailable'));
            fail();
          } else observe(data.observation);
        };
        worker.postMessage({ type: 'init', objects });
      });
      return {
        push: (bitmap) => worker.postMessage({ type: 'frame', bitmap }, [bitmap]),
        close: () => worker.terminate(),
      };
    },
    acquire: async () => {
      try {
        const stream = await acquirePhysicalCamera();
        cameraStatus(`Camera: ${stream.getVideoTracks()[0]?.label ?? 'Selected webcam'}`);
        return stream;
      } catch (error) {
        cameraStatus(error instanceof Error ? error.message : 'Webcam unavailable');
        throw error;
      }
    },
    async attach(stream) {
      video.srcObject = stream;
      await video.play();
    },
    detach() {
      video.pause();
      video.srcObject = null;
    },
    async frame() {
      return video.readyState >= 2 ? createImageBitmap(video) : null;
    },
  };
}
