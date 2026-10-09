/**
 * Shared, DOM-free core of the on-device wearables check (earbuds, headphones, glasses, watch,
 * plus phone / paper notes / a second person). Used by the browser worker, the camera panel and
 * the desktop app's local API (which imports this file directly), so it must stay free of DOM
 * and Node-only APIs.
 *
 * Every model is a D-FINE detector trained on Objects365 (Apache-2.0 weights, see
 * docs/LOCAL_AI.md). Its outputs are `logits` [1, Q, 366] (sigmoid scores, no background
 * column) and `pred_boxes` [1, Q, 4] as normalised (cx, cy, w, h) of the model input.
 */

/** Normalised (0..1) rectangle; x/y is the top-left corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const WEARABLE_CLASSES = [
  'earbuds',
  'headphones',
  'glasses',
  'watch',
  'phone',
  'notes',
  'person',
] as const;
export type WearableClass = (typeof WEARABLE_CLASSES)[number];

/** Objects365 category ids (D-FINE `id2label`) that the check reads; every other id is ignored. */
export const O365_CLASS_IDS: Readonly<Record<number, WearableClass>> = {
  1: 'person', // "Person"
  8: 'glasses', // "Glasses" (spectacles and sunglasses; smart glasses are not a separate class)
  43: 'watch', // "Watch" (wristwatches; smartwatches are not a separate class)
  62: 'phone', // "Cell Phone"
  126: 'headphones', // "Head Phone"
  208: 'earbuds', // "earphone"
  282: 'notes', // "Notepaper"
};
/** Objects365 has 365 categories; the exported heads carry one extra unused column. */
export const O365_LABEL_COUNT = 366;

/**
 * Per-class score floor for one run. Small, low-contrast objects (earbuds) score lower even when
 * right, so their floor is lower; a single run is never enough (see the confirmation below).
 */
export const CLASS_THRESHOLDS: Readonly<Record<WearableClass, number>> = {
  earbuds: 0.35,
  headphones: 0.45,
  glasses: 0.5,
  watch: 0.45,
  phone: 0.5,
  notes: 0.45,
  person: 0.6,
};

/** Which view a run looked at: the whole frame, or a landmark-guided crop around the head. */
export type ViewKind = 'full' | 'head';
/** Classes a view can speak to: a head crop cannot rule out a phone on the desk. */
export const VIEW_CLASSES: Readonly<Record<ViewKind, readonly WearableClass[]>> = {
  full: WEARABLE_CLASSES,
  head: ['earbuds', 'headphones', 'glasses'],
};

export interface WearableDetection {
  readonly cls: WearableClass;
  readonly score: number;
  /** Normalised box in the coordinates of the image it was found in (view, or frame). */
  readonly box: Rect;
}

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Turns raw D-FINE outputs into class detections (in model-input coordinates). Only the seven
 * ids above are read, so this costs Q x 7 sigmoids. Same-class duplicates (IoU > 0.5) are merged.
 */
export function decodeDetections(
  logits: ArrayLike<number>,
  boxes: ArrayLike<number>,
  queries: number,
  labels: number = O365_LABEL_COUNT,
  thresholds: Readonly<Record<WearableClass, number>> = CLASS_THRESHOLDS,
): WearableDetection[] {
  if (logits.length < queries * labels || boxes.length < queries * 4) return [];
  const found: WearableDetection[] = [];
  for (let q = 0; q < queries; q += 1) {
    for (const [id, cls] of Object.entries(O365_CLASS_IDS)) {
      const index = Number(id);
      if (index >= labels) continue;
      const score = sigmoid(logits[q * labels + index] ?? -Infinity);
      if (!(score >= thresholds[cls])) continue;
      const cx = boxes[q * 4] ?? NaN;
      const cy = boxes[q * 4 + 1] ?? NaN;
      const w = boxes[q * 4 + 2] ?? NaN;
      const h = boxes[q * 4 + 3] ?? NaN;
      if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      found.push({ cls, score, box: clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }) });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: WearableDetection[] = [];
  for (const candidate of found) {
    if (kept.some((k) => k.cls === candidate.cls && iou(k.box, candidate.box) > 0.5)) continue;
    kept.push(candidate);
  }
  return kept;
}

export function clampRect(rect: Rect): Rect {
  const x0 = Math.min(1, Math.max(0, rect.x));
  const y0 = Math.min(1, Math.max(0, rect.y));
  const x1 = Math.min(1, Math.max(0, rect.x + rect.w));
  const y1 = Math.min(1, Math.max(0, rect.y + rect.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Maps detections found inside `crop` (a normalised region of the frame) back to frame coordinates. */
export function mapToFrame(
  detections: readonly WearableDetection[],
  crop: Rect,
): WearableDetection[] {
  return detections.map((d) => ({
    ...d,
    box: {
      x: crop.x + d.box.x * crop.w,
      y: crop.y + d.box.y * crop.h,
      w: d.box.w * crop.w,
      h: d.box.h * crop.h,
    },
  }));
}

/** Validates detections from an untrusted source (worker message or local API response). */
export function parseDetections(value: unknown): WearableDetection[] | null {
  if (!Array.isArray(value) || value.length > 300) return null;
  const out: WearableDetection[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { cls, score, box } = item as Record<string, unknown>;
    if (typeof cls !== 'string' || !(WEARABLE_CLASSES as readonly string[]).includes(cls))
      return null;
    if (typeof score !== 'number' || !(score >= 0 && score <= 1)) return null;
    if (typeof box !== 'object' || box === null) return null;
    const { x, y, w, h } = box as Record<string, unknown>;
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    out.push({
      cls: cls as WearableClass,
      score,
      box: clampRect({ x: x as number, y: y as number, w: w as number, h: h as number }),
    });
  }
  return out;
}

// ── Temporal confirmation ─────────────────────────────────────────────────────

/** What the panel shows and the timeline logs. `extra_person` = two or more people in view. */
export const WEARABLE_SIGNALS = [
  'earbuds',
  'headphones',
  'glasses',
  'watch',
  'phone',
  'notes',
  'extra_person',
] as const;
export type WearableSignal = (typeof WEARABLE_SIGNALS)[number];

const SIGNAL_CLASS: Readonly<Record<WearableSignal, WearableClass>> = {
  earbuds: 'earbuds',
  headphones: 'headphones',
  glasses: 'glasses',
  watch: 'watch',
  phone: 'phone',
  notes: 'notes',
  extra_person: 'person',
};

export interface SignalState {
  /** At least `need` of the last `window` runs that could see this signal saw it. */
  readonly confirmed: boolean;
  /** Mean score of the positive runs in the window, or null when none. */
  readonly confidence: number | null;
  /** Number of runs in the window (0 = not checked yet). */
  readonly runs: number;
}
export type WearablesSignals = Readonly<Record<WearableSignal, SignalState>>;

export interface WearablesRun {
  readonly view: ViewKind;
  /** Detections in frame coordinates, already filtered for plausibility. */
  readonly detections: readonly WearableDetection[];
}

export function emptySignals(): WearablesSignals {
  const state = {} as Record<WearableSignal, SignalState>;
  for (const signal of WEARABLE_SIGNALS)
    state[signal] = { confirmed: false, confidence: null, runs: 0 };
  return state;
}

/** Score of one run for one signal, or null when the run did not see it. */
export function signalHit(run: WearablesRun, signal: WearableSignal): number | null {
  const cls = SIGNAL_CLASS[signal];
  const matches = run.detections.filter((d) => d.cls === cls);
  if (signal === 'extra_person') {
    if (matches.length < 2) return null;
    return [...matches].sort((a, b) => b.score - a.score)[1]!.score;
  }
  return matches.length === 0 ? null : Math.max(...matches.map((d) => d.score));
}

/**
 * "At least `need` of the last `window` runs" per signal. A run only counts for the signals its
 * view can see, so a head crop never clears a phone or notes reading.
 */
export function createWearablesConfirmation(window = 3, need = 2) {
  const history = new Map<WearableSignal, (number | null)[]>();
  let state = emptySignals();
  return {
    push(run: WearablesRun): WearablesSignals {
      const next = { ...state } as Record<WearableSignal, SignalState>;
      for (const signal of WEARABLE_SIGNALS) {
        if (!VIEW_CLASSES[run.view].includes(SIGNAL_CLASS[signal])) continue;
        const list = history.get(signal) ?? [];
        list.push(signalHit(run, signal));
        while (list.length > window) list.shift();
        history.set(signal, list);
        const hits = list.filter((v): v is number => v !== null);
        next[signal] = {
          confirmed: hits.length >= need,
          confidence: hits.length === 0 ? null : hits.reduce((a, b) => a + b, 0) / hits.length,
          runs: list.length,
        };
      }
      state = next;
      return state;
    },
    state: (): WearablesSignals => state,
    clear(): void {
      history.clear();
      state = emptySignals();
    },
  };
}
