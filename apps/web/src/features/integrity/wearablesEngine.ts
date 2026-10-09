import {
  createWearablesConfirmation,
  emptySignals,
  mapToFrame,
  type Rect,
  type ViewKind,
  type WearableDetection,
  type WearablesSignals,
} from './wearablesCore.js';
import { createWearableEventTracker, type WearableEvent } from './wearablesEvents.js';
import { headGeometry, plausibleDetections, type FaceKeypoints } from './wearablesGeometry.js';

/** One detector the engine can drive: the desktop app's local API or the in-browser worker. */
export interface WearablesBackend {
  readonly kind: 'local' | 'browser';
  readonly model: string;
  /** Detections in crop coordinates. Must not close or transfer `frame`. */
  detect(
    frame: ImageBitmap,
    view: ViewKind,
    crop: Rect,
  ): Promise<{ readonly detections: readonly WearableDetection[]; readonly inferenceMs: number }>;
  close(): void;
}

/** Minimal frame shape the engine needs (ImageBitmap in the browser, a stub in tests). */
export interface EngineFrame {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface WearablesSnapshot {
  readonly status: 'off' | 'loading' | 'running' | 'unavailable';
  readonly backend: 'local' | 'browser' | null;
  readonly model: string | null;
  readonly signals: WearablesSignals;
  /** Inference time of the latest run, in milliseconds. */
  readonly inferenceMs: number | null;
}

export function emptyWearables(status: WearablesSnapshot['status'] = 'off'): WearablesSnapshot {
  return { status, backend: null, model: null, signals: emptySignals(), inferenceMs: null };
}

export interface WearablesEngineDeps<F extends EngineFrame = ImageBitmap> {
  /** Picks a backend (local API first unless `avoidLocal`), or null when none is usable. */
  connect(avoidLocal: boolean): Promise<WearablesBackend | null>;
  grabFrame(): Promise<F | null>;
  /** Fresh face keypoints of the single tracked face, or null. */
  keypoints(): FaceKeypoints | null;
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
  onSnapshot(snapshot: WearablesSnapshot): void;
  onEvents(events: readonly WearableEvent[]): void;
}

/** About one run every 4 s keeps the cost to a fraction of one core even on the CPU fallback. */
export const WEARABLES_INTERVAL_MS = 4000;
/** Both views run in one cycle only when two inferences fit in this budget. */
export const WEARABLES_BUDGET_MS = 4000;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const MAX_FAILURES = 3;

export function createWearablesEngine<F extends EngineFrame>(
  deps: WearablesEngineDeps<F>,
  options: { readonly intervalMs?: number; readonly budgetMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? WEARABLES_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? WEARABLES_BUDGET_MS;
  const confirmation = createWearablesConfirmation();
  const events = createWearableEventTracker();
  let backend: WearablesBackend | null = null;
  let generation = 0;
  let cancelTimer: (() => void) | null = null;
  let failures = 0;
  let avoidLocal = false;
  let headNext = false;
  let snapshot = emptyWearables();

  const publish = (next: WearablesSnapshot) => {
    snapshot = next;
    deps.onSnapshot(snapshot);
  };

  function plan(geometryAvailable: boolean): ViewKind[] {
    if (!geometryAvailable) return ['full'];
    const fast = snapshot.inferenceMs !== null && snapshot.inferenceMs * 2 <= budgetMs;
    if (fast) return ['full', 'head'];
    headNext = !headNext;
    return [headNext ? 'head' : 'full'];
  }

  async function cycle(token: number): Promise<void> {
    if (token !== generation) return;
    if (backend === null) {
      publish({ ...emptyWearables('loading') });
      const connected = await deps.connect(avoidLocal).catch(() => null);
      if (token !== generation) {
        connected?.close();
        return;
      }
      if (connected === null) {
        publish(emptyWearables('unavailable'));
        return; // Never retried in a loop; a restart (new session) tries again.
      }
      backend = connected;
      publish({ ...snapshot, status: 'running', backend: connected.kind, model: connected.model });
    }
    const frame = await deps.grabFrame().catch(() => null);
    if (token !== generation) {
      frame?.close();
      return;
    }
    if (frame !== null) {
      try {
        const keypoints = deps.keypoints();
        const geometry =
          keypoints === null ? null : headGeometry(keypoints, frame.width, frame.height);
        for (const view of plan(geometry !== null)) {
          const crop = view === 'head' && geometry !== null ? geometry.head : FULL;
          const active: WearablesBackend = backend!;
          const result = await active.detect(frame as unknown as ImageBitmap, view, crop);
          if (token !== generation) return;
          failures = 0;
          const detections = plausibleDetections(mapToFrame(result.detections, crop), geometry);
          const signals = confirmation.push({ view, detections });
          publish({ ...snapshot, signals, inferenceMs: result.inferenceMs });
          const fired = events.update(signals, deps.now());
          if (fired.length > 0) deps.onEvents(fired);
        }
      } catch {
        if (token !== generation) return;
        failures += 1;
        if (failures >= MAX_FAILURES) {
          const failedKind = backend?.kind;
          backend?.close();
          backend = null;
          failures = 0;
          confirmation.clear();
          // A failing local API falls back to the in-browser model once; nothing else retries.
          if (failedKind === 'local' && !avoidLocal) {
            avoidLocal = true;
          } else {
            publish(emptyWearables('unavailable'));
            return;
          }
        }
      } finally {
        frame.close();
      }
    }
    if (token !== generation) return;
    cancelTimer = deps.setTimer(() => void cycle(token), intervalMs);
  }

  return {
    start(): void {
      if (cancelTimer !== null || snapshot.status === 'loading') return;
      const token = ++generation;
      cancelTimer = deps.setTimer(() => void cycle(token), 0);
    },
    stop(): void {
      generation += 1;
      cancelTimer?.();
      cancelTimer = null;
      backend?.close();
      backend = null;
      failures = 0;
      avoidLocal = false;
      confirmation.clear();
      events.reset();
      publish(emptyWearables());
    },
    snapshot: (): WearablesSnapshot => snapshot,
  };
}
