import type { LivenessColour, LivenessRgb } from '@examguard/contracts/exam';

import type { Box } from './gazeEstimator.js';
import { grab, throwIfAborted, type ColourEvidence } from './livenessCapture.js';

/**
 * Mid-exam presence spot check: the server-signed random colour sequence is shown as a subtle
 * glow around the screen edges (never full screen, never over the questions' centre), and the
 * colour reflected on the face is measured on this computer. Nothing blocks answering.
 *
 * Photosensitivity (WCAG 2.3.1 "three flashes or below threshold"): at most 2 colour changes per
 * second (1 per second with prefers-reduced-motion), each a low-opacity edge band, so the
 * luminance change of the screen is capped well below a full-screen flash.
 */
export const MAX_FLASHES_PER_SECOND = 3;

export interface PulseTiming {
  /** How long each colour is shown before its frame is read. */
  readonly flashMs: number;
  /** Neutral time between colours. */
  readonly gapMs: number;
  /** Opacity of the coloured edge band (0..1); caps the luminance change. */
  readonly opacity: number;
  /** Width of the coloured band at each screen edge, in vmin. */
  readonly edgeVmin: number;
}

export const PULSE_TIMING: PulseTiming = { flashMs: 300, gapMs: 200, opacity: 0.45, edgeVmin: 12 };
export const REDUCED_PULSE_TIMING: PulseTiming = {
  flashMs: 400,
  gapMs: 600,
  opacity: 0.3,
  edgeVmin: 12,
};

export function pulseTiming(reducedMotion: boolean): PulseTiming {
  return reducedMotion ? REDUCED_PULSE_TIMING : PULSE_TIMING;
}

/** Colour changes per second for a timing (each colour shown counts as one flash). */
export function flashesPerSecond(timing: PulseTiming): number {
  return 1000 / (timing.flashMs + timing.gapMs);
}

const RGB: Record<LivenessColour, string> = {
  red: '255, 0, 0',
  green: '0, 255, 0',
  blue: '0, 0, 255',
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EdgePulseOptions {
  /** The running exam camera; a clone is read and stopped, the original keeps running. */
  readonly stream: MediaStream;
  /** Latest single-face box from the running camera checks, or null without one. */
  readonly face: () => Box | null;
  readonly reducedMotion?: boolean;
  readonly signal?: AbortSignal;
}

export async function captureEdgePulse(
  sequence: readonly LivenessColour[],
  options: EdgePulseOptions,
): Promise<ColourEvidence> {
  const timing = pulseTiming(options.reducedMotion === true);
  if (flashesPerSecond(timing) > MAX_FLASHES_PER_SECOND)
    throw new Error('Pulse timing exceeds the flash-rate limit.');
  const stream =
    typeof options.stream.clone === 'function' ? options.stream.clone() : options.stream;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.className = 'presence-pulse';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483646',
    'box-sizing:border-box',
    `border:${timing.edgeVmin}vmin solid transparent`,
    'transition:border-color 80ms linear',
  ].join(';');
  try {
    await video.play();
    throwIfAborted(options.signal);
    const cameraLabel = stream.getVideoTracks()[0]?.label ?? '';
    document.body.append(overlay);
    const baseline: LivenessRgb = grab(video, options.face());
    const frames: LivenessRgb[] = [];
    const faces: boolean[] = [];
    for (const colour of sequence) {
      throwIfAborted(options.signal);
      overlay.style.borderColor = `rgba(${RGB[colour]}, ${timing.opacity})`;
      await wait(timing.flashMs);
      throwIfAborted(options.signal);
      const box = options.face();
      faces.push(box !== null);
      frames.push(grab(video, box));
      overlay.style.borderColor = 'transparent';
      await wait(timing.gapMs);
    }
    return { cameraLabel, baseline, frames, faces };
  } finally {
    overlay.remove();
    video.srcObject = null;
    if (stream !== options.stream) stream.getTracks().forEach((track) => track.stop());
  }
}
