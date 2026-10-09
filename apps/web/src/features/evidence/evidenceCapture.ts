import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_PER_ATTEMPT,
  EVIDENCE_MIN_GAP_MS,
  type EvidenceSource,
  type EvidenceTrigger,
  type EvidenceUploadRequest,
} from '@exam-anti-cheat/contracts/exam';

import type { CameraSnapshot } from '../integrity/cameraSession.js';

/** A condition must hold this long before a snapshot is taken (no flicker captures). */
export const EVIDENCE_HOLD_MS = 2000;
/** Looking away briefly is normal; only a long look-away is worth a photo. */
export const LOOK_AWAY_HOLD_MS = 5000;
export const EVIDENCE_MAX_WIDTH = 640;
export const EVIDENCE_JPEG_QUALITY = 0.6;
/** Head-pose angle (degrees) beyond which the face is treated as turned away. */
const LOOK_AWAY_DEGREES = 20;
/** Eye-gaze look-away: gaze must be this many degrees beyond the on-screen rectangle. */
export const GAZE_OFF_SCREEN_DEGREES = 10;

/** The slice of an eye-gaze sample the evidence trigger needs. */
export interface GazeLookAway {
  readonly onScreen: boolean;
  readonly offScreenDeg: number;
}

const holdFor = (trigger: EvidenceTrigger) =>
  trigger === 'look_away' ? LOOK_AWAY_HOLD_MS : EVIDENCE_HOLD_MS;

/** Which unusual conditions the latest local vision result currently shows. */
export function cameraTriggers(
  snapshot: CameraSnapshot,
  gaze?: GazeLookAway | null,
): Set<EvidenceTrigger> {
  const active = new Set<EvidenceTrigger>();
  if (snapshot.phase !== 'live' || snapshot.faces === null) return active;
  if (snapshot.faces >= 2) active.add('multiple_faces');
  if (snapshot.faces === 0) active.add('no_face');
  if (snapshot.phone === 'observed') active.add('phone_detected');
  const pose = snapshot.relative;
  if (snapshot.faces === 1) {
    if (gaze) {
      // Eye gaze (head + iris, calibrated) is the better signal when it is available.
      if (!gaze.onScreen && gaze.offScreenDeg >= GAZE_OFF_SCREEN_DEGREES) active.add('look_away');
    } else if (
      pose !== null &&
      (Math.abs(pose.yaw) > LOOK_AWAY_DEGREES || Math.abs(pose.pitch) > LOOK_AWAY_DEGREES)
    ) {
      active.add('look_away');
    }
  }
  return active;
}

/**
 * Debounce: reports a trigger once its condition has held for its hold time, then not
 * again until the condition clears or the minimum gap has passed.
 */
export function createEvidenceTracker(now: () => number = Date.now) {
  const since = new Map<EvidenceTrigger, number>();
  const lastFired = new Map<EvidenceTrigger, number>();
  return {
    update(active: ReadonlySet<EvidenceTrigger>): EvidenceTrigger[] {
      const at = now();
      const due: EvidenceTrigger[] = [];
      for (const trigger of [...since.keys()]) if (!active.has(trigger)) since.delete(trigger);
      for (const trigger of active) {
        const start = since.get(trigger) ?? at;
        since.set(trigger, start);
        const last = lastFired.get(trigger);
        if (
          at - start >= holdFor(trigger) &&
          (last === undefined || at - last >= EVIDENCE_MIN_GAP_MS)
        ) {
          lastFired.set(trigger, at);
          due.push(trigger);
        }
      }
      return due;
    },
    reset(): void {
      since.clear();
      lastFired.clear();
    },
  };
}

/**
 * Downscale the already-open camera frame to <= 640 px wide and encode as JPEG q0.6.
 * Returns base64 (no data: prefix) or null when no frame is ready or it is too big.
 */
export function captureWebcamJpeg(video: HTMLVideoElement | null): string | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }
  const scale = Math.min(1, EVIDENCE_MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', EVIDENCE_JPEG_QUALITY);
    return base64Jpeg(url);
  } catch {
    return null;
  }
}

/** Accepts a data URL or bare base64; null unless it is a JPEG within the size cap. */
export function base64Jpeg(value: string): string | null {
  const prefix = 'data:image/jpeg;base64,';
  const base64 = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return null;
  const approxBytes = Math.floor((base64.length * 3) / 4);
  return approxBytes <= EVIDENCE_MAX_BYTES && base64.startsWith('/9j/') ? base64 : null;
}

/** Desktop shell only (Electron preload). Resolves to a base64 JPEG of the primary screen or null. */
export interface ScreenSnapshotBridge {
  captureScreenSnapshot(): Promise<string | null>;
}
export function screenSnapshotBridge(): ScreenSnapshotBridge | undefined {
  const bridge = (window as Window & { electronExam?: Partial<ScreenSnapshotBridge> }).electronExam;
  return typeof bridge?.captureScreenSnapshot === 'function'
    ? (bridge as ScreenSnapshotBridge)
    : undefined;
}

/** Triggers that also warrant a screen snapshot (desktop app only). */
const SCREEN_TRIGGERS: ReadonlySet<EvidenceTrigger> = new Set([
  'overlay_detected',
  'disallowed_app_foreground',
]);

export interface EvidenceCaptureOptions {
  readonly attemptId: string;
  readonly getVideo: () => HTMLVideoElement | null;
  readonly post: (attemptId: string, request: EvidenceUploadRequest) => Promise<void>;
  readonly screen?: ScreenSnapshotBridge | undefined;
  readonly now?: () => number;
}

/**
 * Takes single still snapshots when a trigger holds. Never records continuous video.
 * The client-side caps mirror the server: 1 per (source, trigger) per 30 s, 60 per attempt.
 */
export function createEvidenceCapture(options: EvidenceCaptureOptions) {
  const now = options.now ?? Date.now;
  const tracker = createEvidenceTracker(now);
  const recent = new Map<string, number>();
  const eventState = new Map<EvidenceTrigger, { since: number; last: number }>();
  let sent = 0;
  let stopped = false;

  async function submit(
    source: EvidenceSource,
    trigger: EvidenceTrigger,
    image: string | null,
  ): Promise<void> {
    if (stopped || image === null || sent >= EVIDENCE_MAX_PER_ATTEMPT) return;
    const key = `${source}:${trigger}`;
    const at = now();
    const last = recent.get(key);
    if (last !== undefined && at - last < EVIDENCE_MIN_GAP_MS) return;
    recent.set(key, at);
    sent += 1;
    try {
      await options.post(options.attemptId, {
        source,
        trigger,
        capturedAt: new Date(at).toISOString(),
        imageJpegBase64: image,
      });
    } catch {
      // A failed upload is never retried in a loop; the next sustained trigger tries again.
    }
  }

  async function fire(trigger: EvidenceTrigger): Promise<void> {
    await submit('webcam', trigger, captureWebcamJpeg(options.getVideo()));
    if (options.screen && SCREEN_TRIGGERS.has(trigger)) {
      let screenImage: string | null = null;
      try {
        screenImage = base64Jpeg((await options.screen.captureScreenSnapshot()) ?? '');
      } catch {
        screenImage = null;
      }
      await submit('screen', trigger, screenImage);
    }
  }

  return {
    /** Feed every vision result; fires any condition that has now held long enough. */
    observeCamera(snapshot: CameraSnapshot, gaze?: GazeLookAway | null): void {
      if (stopped) return;
      for (const trigger of tracker.update(cameraTriggers(snapshot, gaze))) void fire(trigger);
    },
    /**
     * Feed repeated reports of an event-style condition (overlay, foreground app). The
     * condition counts as held once reports span the hold time with gaps under 5 s.
     */
    observeEvent(trigger: EvidenceTrigger): void {
      const at = now();
      const state = eventState.get(trigger);
      if (state === undefined || at - state.last > 5000) {
        eventState.set(trigger, { since: at, last: at });
        return;
      }
      state.last = at;
      if (at - state.since >= EVIDENCE_HOLD_MS) {
        eventState.set(trigger, { since: at, last: at });
        void fire(trigger);
      }
    },
    /** One-shot capture for an instantaneous event (no hold time); still rate-limited by `submit`. */
    captureNow(trigger: EvidenceTrigger): void {
      if (!stopped) void fire(trigger);
    },
    stop(): void {
      stopped = true;
      tracker.reset();
      eventState.clear();
    },
  };
}
