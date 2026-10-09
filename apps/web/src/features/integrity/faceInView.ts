import { useEffect, useState } from 'react';

import { LIGHTING_THRESHOLDS } from './lightingAnalysis.js';
import { meanLuminance } from './livenessCapture.js';
import { openSetupFaceSource, type SetupFaceSource } from './setupFaceSource.js';

/**
 * Pre-exam camera step: after the camera gate accepted a native webcam, exactly one face must be
 * visible for FACE_REQUIRED_MS of a FACE_WINDOW_MS window. Runs on this device; nothing is sent.
 */
export const FACE_WINDOW_MS = 3000;
export const FACE_REQUIRED_MS = 2000;
export const FACE_POLL_MS = 250;
/** A gap longer than this between frames does not count as time with a face. */
const MAX_SAMPLE_SPAN_MS = FACE_POLL_MS * 3;

export interface FaceSample {
  /** Monotonic milliseconds. */
  readonly at: number;
  /** Faces in the frame; null when the model returned nothing. */
  readonly faces: number | null;
}

export type FaceVerdict = 'ok' | 'no_face' | 'multiple';

/** Pure window evaluation; `now` is the time of the evaluation. */
export function evaluateFaceWindow(samples: readonly FaceSample[], now: number): FaceVerdict {
  const recent = samples.filter((s) => s.at > now - FACE_WINDOW_MS && s.at <= now);
  let singleMs = 0;
  recent.forEach((sample, index) => {
    const end = recent[index + 1]?.at ?? now;
    if (sample.faces === 1) singleMs += Math.min(Math.max(0, end - sample.at), MAX_SAMPLE_SPAN_MS);
  });
  if (singleMs >= FACE_REQUIRED_MS) return 'ok';
  const latest = recent.slice(-3);
  if (latest.length > 0 && latest.filter((s) => (s.faces ?? 0) > 1).length * 2 > latest.length)
    return 'multiple';
  return 'no_face';
}

export type FaceViewState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'watching'; readonly verdict: FaceVerdict; readonly dark: boolean }
  | { readonly phase: 'passed' }
  | { readonly phase: 'unavailable'; readonly message: string };

export interface FaceMonitorDeps {
  readonly source: SetupFaceSource;
  readonly now: () => number;
  /** Mean luminance 0..255 of the current frame, or null when unreadable. */
  readonly luminance?: () => number | null;
  readonly onChange: (state: FaceViewState) => void;
}

/** Feeds frames into the window; call `tick()` every FACE_POLL_MS. Latches once passed. */
export function createFaceMonitor(deps: FaceMonitorDeps) {
  const samples: FaceSample[] = [];
  let passed = false;
  let busy = false;
  return {
    async tick(): Promise<void> {
      if (passed || busy) return;
      busy = true;
      try {
        let faces: number | null = null;
        try {
          faces = await deps.source.faces();
        } catch {
          faces = null;
        }
        const now = deps.now();
        samples.push({ at: now, faces });
        while (samples.length > 0 && samples[0]!.at <= now - FACE_WINDOW_MS * 2) samples.shift();
        const verdict = evaluateFaceWindow(samples, now);
        if (verdict === 'ok') {
          passed = true;
          deps.onChange({ phase: 'passed' });
          return;
        }
        const level = deps.luminance?.() ?? null;
        deps.onChange({
          phase: 'watching',
          verdict,
          dark: level !== null && level < LIGHTING_THRESHOLDS.tooDark,
        });
      } finally {
        busy = false;
      }
    },
    get passed() {
      return passed;
    },
  };
}

function readLuminance(video: HTMLVideoElement): number | null {
  if (video.readyState < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return meanLuminance(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}

/**
 * Watches `stream` until one face was seen long enough. `enabled` false (or a null stream)
 * resets to idle; a new stream starts over. `attempt` re-runs after "unavailable".
 */
export function useFaceInView(
  stream: MediaStream | null,
  enabled: boolean,
  attempt = 0,
  open: (video: HTMLVideoElement) => Promise<SetupFaceSource> = openSetupFaceSource,
): FaceViewState {
  const [state, setState] = useState<FaceViewState>({ phase: 'idle' });
  useEffect(() => {
    if (!enabled || stream === null) {
      setState({ phase: 'idle' });
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let source: SetupFaceSource | null = null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    setState({ phase: 'loading' });
    void (async () => {
      try {
        await video.play().catch(() => {});
        const opened = await open(video);
        if (disposed) {
          opened.close();
          return;
        }
        source = opened;
        const monitor = createFaceMonitor({
          source: opened,
          now: () => performance.now(),
          luminance: () => readLuminance(video),
          onChange: (next) => {
            if (disposed) return;
            setState(next);
            if (next.phase === 'passed' && timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
          },
        });
        timer = setInterval(() => void monitor.tick(), FACE_POLL_MS);
      } catch {
        if (!disposed)
          setState({
            phase: 'unavailable',
            message: 'The face check could not start on this computer. Press Try again.',
          });
      }
    })();
    return () => {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      source?.close();
      video.srcObject = null;
    };
  }, [stream, enabled, attempt, open]);
  return state;
}
