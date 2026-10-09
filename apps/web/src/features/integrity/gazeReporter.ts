import type { HeadPose } from './visionSignals.js';

/**
 * Turns the 1 Hz camera readings into a few debounced "direction held for N
 * seconds" events for the unified integrity log. It never sees images and never
 * posts per frame: a change must hold for DEBOUNCE_MS before it counts, short
 * glances under MIN_EVENT_MS are dropped, and long stretches are cut into
 * MAX_CHUNK_MS pieces. Direction is camera-relative head pose, not eye gaze.
 */
export type GazeDirection = 'left' | 'right' | 'up' | 'down' | 'no_face' | 'multiple_faces';

export interface GazeEvent {
  readonly timestamp: number;
  readonly durationMs: number;
  readonly direction: GazeDirection;
  readonly yaw?: number;
  readonly pitch?: number;
}

export const GAZE_TURN_DEGREES = 20;
export const DEBOUNCE_MS = 1500;
export const MIN_EVENT_MS = 2000;
export const MAX_CHUNK_MS = 30_000;
const FLUSH_DELAY_MS = 10_000;
const MAX_QUEUE = 100;
const PHONE_COOLDOWN_MS = 60_000;

export interface GazeReading {
  /** Null while the vision result is stale: the tracker holds its state. */
  readonly faces: number | null;
  /** Calibrated pose when available, else the raw camera-relative pose. */
  readonly pose: HeadPose | null;
  readonly phone?: 'waiting' | 'unavailable' | 'not_observed' | 'candidate' | 'observed';
}

/** `forward` is the resting state; null means "no usable reading". */
export function classifyGaze(reading: GazeReading): GazeDirection | 'forward' | null {
  if (reading.faces === null) return null;
  if (reading.faces === 0) return 'no_face';
  if (reading.faces > 1) return 'multiple_faces';
  const pose = reading.pose;
  if (pose === null || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) return null;
  const horizontal = Math.abs(pose.yaw) > GAZE_TURN_DEGREES;
  const vertical = Math.abs(pose.pitch) > GAZE_TURN_DEGREES;
  if (!horizontal && !vertical) return 'forward';
  if (horizontal && (!vertical || Math.abs(pose.yaw) >= Math.abs(pose.pitch))) {
    return pose.yaw > 0 ? 'right' : 'left';
  }
  return pose.pitch > 0 ? 'up' : 'down';
}

export function createGazeTracker(onEvent: (event: GazeEvent) => void) {
  let current: { direction: GazeDirection; start: number; yaw: number; pitch: number } | null =
    null;
  let pending: { state: GazeDirection | 'forward'; since: number } | null = null;

  function emit(end: number): void {
    if (current === null) return;
    const durationMs = Math.round(end - current.start);
    if (durationMs >= MIN_EVENT_MS) {
      onEvent({
        timestamp: current.start,
        durationMs,
        direction: current.direction,
        yaw: current.yaw,
        pitch: current.pitch,
      });
    }
  }

  return {
    sample(reading: GazeReading, now: number): void {
      const state = classifyGaze(reading);
      if (state === null) return;
      const holding = current === null ? 'forward' : current.direction;
      if (state === holding) {
        pending = null;
        if (current !== null) {
          if (now - current.start >= MAX_CHUNK_MS) {
            emit(now);
            current = { ...current, start: now };
          }
          if (reading.pose !== null && Math.abs(reading.pose.yaw) > Math.abs(current.yaw))
            current = { ...current, yaw: Math.round(reading.pose.yaw) };
          if (reading.pose !== null && Math.abs(reading.pose.pitch) > Math.abs(current.pitch))
            current = { ...current, pitch: Math.round(reading.pose.pitch) };
        }
        return;
      }
      if (pending === null || pending.state !== state) pending = { state, since: now };
      if (now - pending.since < DEBOUNCE_MS) return;
      // The change held long enough: close the old segment at the first sign of the change.
      emit(pending.since);
      current =
        state === 'forward'
          ? null
          : {
              direction: state,
              start: pending.since,
              yaw: Math.round(reading.pose?.yaw ?? 0),
              pitch: Math.round(reading.pose?.pitch ?? 0),
            };
      pending = null;
    },
    /** Close any open stretch (camera stopped, page left). */
    flush(now: number): void {
      emit(now);
      current = null;
      pending = null;
    },
  };
}

export interface GazeReporterApi {
  uploadTelemetry(attemptId: string, payload: unknown): Promise<void>;
  patchEvents(attemptId: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Queues tracker events and posts them in small batches through the existing
 * telemetry endpoint. Failures are dropped: the exam must never depend on this.
 */
export function createGazeReporter(
  attemptId: string,
  api: GazeReporterApi,
  clock: () => number = Date.now,
) {
  let queue: GazeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPhone = -Infinity;
  let stopped = false;

  function send(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return;
    const gaze = queue;
    queue = [];
    api.uploadTelemetry(attemptId, { gaze }).catch(() => {});
  }
  const tracker = createGazeTracker((event) => {
    if (queue.length >= MAX_QUEUE) return;
    queue.push(event);
    timer ??= setTimeout(send, FLUSH_DELAY_MS);
  });

  return {
    sample(reading: GazeReading): void {
      if (stopped) return;
      const now = clock();
      tracker.sample(reading, now);
      if (reading.phone === 'observed' && now - lastPhone >= PHONE_COOLDOWN_MS) {
        lastPhone = now;
        api.patchEvents(attemptId, { event: 'phone_detected' }).catch(() => {});
      }
    },
    /** Camera went off: close the open stretch and post what is queued. */
    pause(): void {
      tracker.flush(clock());
      send();
    },
    stop(): void {
      this.pause();
      stopped = true;
    },
  };
}
