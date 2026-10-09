import type { AttemptContext } from './browserIntegrity.js';
import {
  createPhoneConfirmation,
  relativePose,
  type HeadPose,
  type VisionObservation,
} from './visionSignals.js';

export interface CameraSnapshot {
  readonly phase: 'off' | 'loading' | 'permission' | 'live';
  readonly reason: string;
  readonly remainingSeconds: number;
  readonly faces: number | null;
  readonly phone: 'waiting' | 'unavailable' | 'not_observed' | 'candidate' | 'observed';
  readonly earbuds: boolean | null;
  readonly smartGlasses: boolean | null;
  readonly relative: HeadPose | null;
  readonly calibrated: boolean;
}
export interface CameraEngine {
  push(frame: ImageBitmap): void;
  close(): void;
}
export interface CameraEnvironment {
  readonly page: EventTarget;
  readonly window: EventTarget;
  wallNow(): number;
  monotonicNow(): number;
  hidden(): boolean;
  everyTick(callback: () => void): () => void;
  prepare(
    signal: AbortSignal,
    observe: (value: VisionObservation) => void,
    fail: () => void,
  ): Promise<CameraEngine>;
  acquire(): Promise<MediaStream>;
  attach(stream: MediaStream): Promise<void>;
  detach(): void;
  frame(): Promise<ImageBitmap | null>;
}

export function emptyCamera(reason = 'Not started'): CameraSnapshot {
  return {
    phase: 'off',
    reason,
    remainingSeconds: 0,
    faces: null,
    phone: 'waiting',
    earbuds: null,
    smartGlasses: null,
    relative: null,
    calibrated: false,
  };
}

/** Owns every camera resource and async generation; it cannot call the answer API. */
export function createCameraSession(
  env: CameraEnvironment,
  getAttempt: () => AttemptContext,
  publish: (snapshot: CameraSnapshot) => void,
) {
  let state = emptyCamera();
  let disposed = false;
  let generation = 0;
  let attemptId = '';
  let initialDeadline = 0;
  let abort: AbortController | null = null;
  let engine: CameraEngine | null = null;
  let stream: MediaStream | null = null;
  let latest: VisionObservation | null = null;
  let latestAt = -Infinity;
  let baseline: HeadPose | null = null;
  let pending = false;
  let frameStarted = -Infinity;
  const remove: Array<() => void> = [];
  const phone = createPhoneConfirmation();
  const notify = () => {
    if (!disposed) publish(state);
  };

  function stop(reason = 'Stopped and cleared'): void {
    generation += 1;
    for (const cleanup of remove.splice(0)) cleanup();
    abort?.abort();
    abort = null;
    engine?.close();
    engine = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    env.detach();
    latest = baseline = null;
    latestAt = frameStarted = -Infinity;
    pending = false;
    phone.clear();
    state = emptyCamera(reason);
    notify();
  }
  function remaining(): number {
    // No 120-second wall-clock cap — run for the exam's full duration
    return Math.min(getAttempt().deadline, initialDeadline) - env.wallNow();
  }
  function valid(token: number): boolean {
    if (disposed || generation !== token || state.phase === 'off') return false;
    const attempt = getAttempt();
    if (!attempt.active || attempt.id !== attemptId) {
      stop('Exam ended or changed');
      return false;
    }
    if (!Number.isFinite(attempt.deadline) || remaining() <= 0) {
      stop('Time limit reached');
      return false;
    }
    // No longer stopping on page hidden — camera keeps running
    return true;
  }
  function listen(target: EventTarget, type: string, callback: EventListener): void {
    target.addEventListener(type, callback);
    remove.push(() => target.removeEventListener(type, callback));
  }
  async function capture(token: number): Promise<void> {
    if (
      !valid(token) ||
      state.phase !== 'live' ||
      pending ||
      env.monotonicNow() - frameStarted < 1000
    )
      return;
    pending = true;
    frameStarted = env.monotonicNow();
    try {
      const frame = await env.frame();
      if (!valid(token)) {
        frame?.close();
        return;
      }
      if (frame === null) {
        pending = false;
        return;
      }
      try {
        engine!.push(frame);
      } catch (error) {
        frame.close();
        throw error;
      }
    } catch {
      if (valid(token)) stop('Camera frame unavailable — exam remains usable');
    }
  }
  async function start(consented: boolean): Promise<void> {
    const attempt = getAttempt();
    if (
      disposed ||
      !consented ||
      state.phase !== 'off' ||
      !attempt.active ||
      env.hidden() ||
      !Number.isFinite(attempt.deadline) ||
      attempt.deadline <= env.wallNow()
    )
      return;
    const token = ++generation;
    attemptId = attempt.id;
    initialDeadline = attempt.deadline;
    abort = new AbortController();
    state = {
      ...emptyCamera(),
      phase: 'loading',
      reason: 'Checking local models and network policy',
      remainingSeconds: Math.ceil(remaining() / 1000),
    };
    listen(env.page, 'visibilitychange', () => {
      if (generation === token && env.hidden())
        stop('Page hidden — restart explicitly to continue');
    });
    listen(env.window, 'pagehide', () => {
      if (generation === token) stop('Page left');
    });
    remove.push(
      env.everyTick(() => {
        if (!valid(token)) return;
        if (pending && env.monotonicNow() - frameStarted > 10_000) {
          stop('Vision engine timed out');
          return;
        }
        if (latest !== null && env.monotonicNow() - latestAt > 1500) {
          latest = baseline = null;
          phone.clear();
          state = {
            ...state,
            faces: null,
            phone: 'waiting',
            earbuds: null,
            smartGlasses: null,
            calibrated: false,
            relative: null,
          };
        }
        state = { ...state, remainingSeconds: Math.ceil(remaining() / 1000) };
        notify();
        void capture(token);
      }),
    );
    notify();
    try {
      const prepared = await env.prepare(
        abort.signal,
        (observation) => {
          if (!valid(token) || state.phase !== 'live' || !pending) return;
          pending = false;
          latest = observation;
          latestAt = env.monotonicNow();
          if (observation.faces !== 1 || observation.pose === null) baseline = null;
          const confirmed = phone.sample(observation.phone, latestAt);
          state = {
            ...state,
            faces: observation.faces,
            phone:
              observation.phoneAvailable === false
                ? 'unavailable'
                : confirmed
                  ? 'observed'
                  : observation.phone
                    ? 'candidate'
                    : 'not_observed',
            earbuds: observation.earbuds ?? null,
            smartGlasses: observation.smartGlasses ?? null,
            calibrated: baseline !== null,
            relative:
              baseline !== null && observation.pose !== null
                ? relativePose(observation.pose, baseline)
                : null,
          };
          notify();
        },
        () => {
          if (valid(token)) stop('Vision engine unavailable — exam remains usable');
        },
      );
      if (!valid(token)) {
        prepared.close();
        return;
      }
      engine = prepared;
      state = { ...state, phase: 'permission', reason: 'Waiting for camera permission' };
      notify();
      const acquired = await env.acquire();
      // Browser permission dialogs cannot be cancelled programmatically. Late streams
      // must be stopped even after unmount, revocation, expiry, or a newer session.
      if (!valid(token)) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      for (const track of acquired.getTracks()) {
        listen(track, 'ended', () => {
          if (valid(token)) stop('Camera disconnected');
        });
      }
      await env.attach(acquired);
      if (!valid(token)) return;
      state = { ...state, phase: 'live', reason: 'Local processing active' };
      notify();
    } catch {
      if (valid(token))
        stop('Camera or local models unavailable — check permissions and run vision:prepare');
    }
  }
  return {
    start,
    stop,
    calibrate(): boolean {
      if (
        !valid(generation) ||
        latest?.faces !== 1 ||
        latest.pose === null ||
        env.monotonicNow() - latestAt > 1500
      )
        return false;
      baseline = { ...latest.pose };
      state = { ...state, calibrated: true, relative: { yaw: 0, pitch: 0 } };
      notify();
      return true;
    },
    snapshot: () => state,
    destroy(): void {
      disposed = true;
      stop();
    },
  };
}
