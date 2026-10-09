import { acquirePhysicalCamera } from './physicalCamera.js';

export interface LivenessEvidence {
  readonly imageBase64: string;
  readonly cameraLabel: string;
  /** Mean-luminance rise (0–255) between a baseline frame and a frame during the white flash. */
  readonly brightnessDelta?: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mean perceived luminance (Rec. 601) of RGBA pixel data, 0–255. */
export function meanLuminance(pixels: Uint8ClampedArray): number {
  let total = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    total += 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
  }
  return count === 0 ? 0 : total / count;
}

function grab(video: HTMLVideoElement): { luminance: number; jpeg: string } {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Camera frames cannot be read in this browser.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    luminance: meanLuminance(data),
    jpeg: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '',
  };
}

/**
 * Capture liveness evidence from the native webcam only. The camera is opened
 * through the same physical-camera check as the exam gate, so OBS and other
 * virtual sources are refused. For a flash challenge the screen turns white
 * and the real brightness change on the student's face is measured: a looped
 * recording or virtual feed does not light up with the screen.
 */
export async function captureLivenessEvidence(
  type: string,
  acquire: () => Promise<MediaStream> = acquirePhysicalCamera,
): Promise<LivenessEvidence> {
  const stream = await acquire();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    await wait(600); // let auto-exposure settle
    const cameraLabel = stream.getVideoTracks()[0]?.label ?? '';
    const baseline = grab(video);
    if (type !== 'flash') return { imageBase64: baseline.jpeg, cameraLabel };

    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647';
    document.body.append(flash);
    try {
      await wait(350);
      const lit = grab(video);
      return {
        imageBase64: lit.jpeg,
        cameraLabel,
        brightnessDelta: Math.round((lit.luminance - baseline.luminance) * 10) / 10,
      };
    } finally {
      flash.remove();
    }
  } finally {
    video.srcObject = null;
    stream.getTracks().forEach((track) => track.stop());
  }
}
