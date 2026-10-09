import type { LivenessColour, LivenessRgb } from '@exam-anti-cheat/contracts/exam';

import { acquirePhysicalCamera } from './physicalCamera.js';

export interface ColourEvidence {
  readonly cameraLabel: string;
  readonly baseline: LivenessRgb;
  readonly frames: readonly LivenessRgb[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The check timed out or was closed.');
}

/** Acquires a stream, releasing it at once if the check was abandoned while the prompt was open. */
export async function acquireUnlessAborted(
  acquire: () => Promise<MediaStream>,
  signal?: AbortSignal,
): Promise<MediaStream> {
  const stream = await acquire();
  if (signal?.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    throwIfAborted(signal);
  }
  return stream;
}

/** How long each colour stays on screen before its frame is read. */
export const FLASH_MS = 350;
/** Neutral gap between colours keeps the sequence under ~2 flashes per second. */
export const GAP_MS = 150;

const FLASH_CSS: Record<LivenessColour, string> = {
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
};

/** Mean luminance (Rec. 601) of RGBA pixel data, 0-255. */
export function meanLuminance(pixels: Uint8ClampedArray): number {
  let total = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    total += 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
  }
  return count === 0 ? 0 : total / count;
}

/** Mean RGB of the centre 50% (by width and height) of an RGBA image. */
export function centreMeanRgb(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): LivenessRgb {
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.ceil(width * 0.75);
  const y0 = Math.floor(height * 0.25);
  const y1 = Math.ceil(height * 0.75);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      r += pixels[i]!;
      g += pixels[i + 1]!;
      b += pixels[i + 2]!;
      count += 1;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0 };
  const round = (value: number) => Math.round((value / count) * 100) / 100;
  return { r: round(r), g: round(g), b: round(b) };
}

function grab(video: HTMLVideoElement): LivenessRgb {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Camera frames cannot be read in this browser.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return centreMeanRgb(data, canvas.width, canvas.height);
}

async function openVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  return video;
}

/** Opens the native webcam only (OBS/virtual cameras are refused) and returns its label. */
export async function readCameraLabel(
  acquire: () => Promise<MediaStream> = acquirePhysicalCamera,
  signal?: AbortSignal,
): Promise<string> {
  const stream = await acquireUnlessAborted(acquire, signal);
  try {
    return stream.getVideoTracks()[0]?.label ?? '';
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

/**
 * Shows each requested colour full-screen and reads the mean RGB of the centre
 * of the native webcam frame during it, plus a baseline taken beforehand. All
 * processing is on-device; only the numbers are sent. A looped recording or
 * virtual feed does not change colour with the screen.
 */
export async function captureColourFlash(
  sequence: readonly LivenessColour[],
  acquire: () => Promise<MediaStream> = acquirePhysicalCamera,
  signal?: AbortSignal,
): Promise<ColourEvidence> {
  const stream = await acquireUnlessAborted(acquire, signal);
  let video: HTMLVideoElement | null = null;
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  try {
    video = await openVideo(stream);
    await wait(600); // let auto-exposure settle
    throwIfAborted(signal);
    const cameraLabel = stream.getVideoTracks()[0]?.label ?? '';
    // Baseline under the same neutral grey the gaps use, so only the colour differs.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#808080';
    document.body.append(overlay);
    await wait(400);
    throwIfAborted(signal);
    const baseline = grab(video);
    const frames: LivenessRgb[] = [];
    for (const colour of sequence) {
      throwIfAborted(signal);
      overlay.style.background = '#808080';
      await wait(GAP_MS);
      overlay.style.background = FLASH_CSS[colour];
      await wait(FLASH_MS);
      throwIfAborted(signal);
      frames.push(grab(video));
    }
    return { cameraLabel, baseline, frames };
  } finally {
    overlay.remove();
    if (video) video.srcObject = null;
    stream.getTracks().forEach((track) => track.stop());
  }
}
