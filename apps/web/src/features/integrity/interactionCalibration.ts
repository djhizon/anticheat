import { useEffect } from 'react';
import type { EyeGazeTracker, InteractionEvent } from './eyeGazeTracker.js';
import type { ScreenPoint } from './implicitCalibration.js';

/**
 * DOM side of implicit gaze calibration. Clicks/taps, focusing an answer field and typing in
 * one are turned into (time, screen-normalised point) events for the gaze tracker. Only
 * positions and timing are used: no key values, no text, nothing leaves the device.
 */

/** Elements larger than this share of the viewport only give an imprecise target. */
const PRECISE_MAX_WIDTH = 0.6;
const PRECISE_MAX_HEIGHT = 0.35;
/** At most one typing event per this many milliseconds. */
const TYPING_THROTTLE_MS = 250;
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file']);

type WindowLike = Pick<
  Window,
  'innerWidth' | 'innerHeight' | 'outerWidth' | 'outerHeight' | 'screenX' | 'screenY'
> & { readonly screen?: { readonly width: number; readonly height: number } | undefined };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Converts viewport (client) coordinates to screen-normalised coordinates: x -1..1 left to right,
 * y -1..1 bottom to top. Assumes the browser chrome is on top (outer minus inner height) and
 * split evenly left/right. Falls back to viewport-normalised coordinates when the window
 * position is unknown or the window is on another display.
 */
export function screenPoint(clientX: number, clientY: number, win: WindowLike): ScreenPoint {
  const vw = win.innerWidth > 0 ? win.innerWidth : 1;
  const vh = win.innerHeight > 0 ? win.innerHeight : 1;
  const viewport = { x: (2 * clientX) / vw - 1, y: 1 - (2 * clientY) / vh };
  const sw = win.screen?.width ?? 0;
  const sh = win.screen?.height ?? 0;
  if (!(sw > 0 && sh > 0) || !(win.outerWidth > 0 && win.outerHeight > 0))
    return clampPoint(viewport);
  const sx = win.screenX + Math.max(0, win.outerWidth - win.innerWidth) / 2 + clientX;
  const sy = win.screenY + Math.max(0, win.outerHeight - win.innerHeight) + clientY;
  if (sx < -0.1 * sw || sx > 1.1 * sw || sy < -0.1 * sh || sy > 1.1 * sh)
    return clampPoint(viewport);
  return clampPoint({ x: (2 * sx) / sw - 1, y: 1 - (2 * sy) / sh });
}

function clampPoint(p: ScreenPoint): ScreenPoint {
  return { x: clamp(p.x, -1.2, 1.2), y: clamp(p.y, -1.2, 1.2) };
}

/** Centre of an element and whether it is small enough to be a precise gaze target. */
export function elementTarget(
  element: Element,
  win: WindowLike,
): { readonly point: ScreenPoint; readonly precise: boolean } | null {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const precise =
    rect.width <= PRECISE_MAX_WIDTH * win.innerWidth &&
    rect.height <= PRECISE_MAX_HEIGHT * win.innerHeight;
  return {
    point: screenPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, win),
    precise,
  };
}

function editableTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(EDITABLE);
  if (el === null) return null;
  if (el instanceof HTMLInputElement && NON_TEXT_INPUTS.has(el.type)) return null;
  return el;
}

/**
 * Listens (passive, capture phase) for pointer down, focus and keystrokes on the document and
 * forwards them as interaction events. Returns a detach function.
 */
export function attachInteractionCalibration(
  sink: (event: InteractionEvent) => void,
  options: {
    readonly doc?: Document;
    readonly win?: Window;
    readonly now?: () => number;
    /** Ignore synthetic (script-dispatched) events. Tests turn this off. */
    readonly trustedOnly?: boolean;
  } = {},
): () => void {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const now = options.now ?? (() => performance.now());
  const trustedOnly = options.trustedOnly ?? true;
  let lastTyping = -Infinity;
  const emit = (event: InteractionEvent) => {
    try {
      sink(event);
    } catch {
      // Calibration must never break the exam page.
    }
  };
  const onPointer = (event: PointerEvent) => {
    if (trustedOnly && !event.isTrusted) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    emit({
      kind: 'pointer',
      t: now(),
      point: screenPoint(event.clientX, event.clientY, win),
      precise: true,
    });
  };
  const onFocus = (event: FocusEvent) => {
    if (trustedOnly && !event.isTrusted) return;
    const el = editableTarget(event.target);
    const target = el && elementTarget(el, win);
    if (target) emit({ kind: 'focus', t: now(), ...target });
  };
  const onKey = (event: KeyboardEvent) => {
    if (trustedOnly && !event.isTrusted) return;
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Alt' ||
      event.key === 'Meta'
    )
      return;
    const t = now();
    if (t - lastTyping < TYPING_THROTTLE_MS) return;
    const el = editableTarget(event.target);
    const target = el && elementTarget(el, win);
    if (!target) return;
    lastTyping = t;
    emit({ kind: 'typing', t, ...target });
  };
  const opts = { capture: true, passive: true } as const;
  doc.addEventListener('pointerdown', onPointer, opts);
  doc.addEventListener('focusin', onFocus, opts);
  doc.addEventListener('keydown', onKey, opts);
  return () => {
    doc.removeEventListener('pointerdown', onPointer, opts);
    doc.removeEventListener('focusin', onFocus, opts);
    doc.removeEventListener('keydown', onKey, opts);
  };
}

/** Feeds the page's clicks/focus/typing into the tracker while `active` (camera live). */
export function useImplicitGazeCalibration(tracker: EyeGazeTracker, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return attachInteractionCalibration((event) => tracker.observeInteraction(event));
  }, [tracker, active]);
}
