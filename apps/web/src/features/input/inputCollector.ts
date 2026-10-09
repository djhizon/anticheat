import type { InputBehaviourEvent, InputBehaviourWindow } from '@examguard/contracts/exam';

import {
  INPUT_THRESHOLDS,
  createBurstAfterIdleDetector,
  createDriftTracker,
  createInjectionDetector,
  createPointerMotionAnalyzer,
  createPointerOutsideTracker,
  createTypingAnalyzer,
  looksSynthetic,
  nearestEdge,
  type TypingProfile,
} from './inputDetectors.js';
import { createKeyRecorder } from './keyRecorder.js';

export const INPUT_WINDOW_MS = 20_000;
/** The same event name is reported at most this often. */
export const INPUT_EVENT_GAP_MS = 30_000;

export interface InputCollectorOptions {
  readonly emitEvent: (event: InputBehaviourEvent) => void;
  readonly flushWindow: (window: InputBehaviourWindow) => void;
  /** Called when text injection is detected (the caller may take an evidence snapshot). */
  readonly onInjection?: () => void;
  /** Typing baseline from pre-exam setup typing, if any happened there. */
  readonly baseline?: TypingProfile | null;
  readonly doc?: Document;
  readonly now?: () => number;
  readonly epoch?: () => number;
}

const EDITABLE = 'textarea, input, [contenteditable=""], [contenteditable="true"]';
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password']);

function isEditable(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target === null || !('tagName' in target)) return false;
  const el = target as Element;
  if (!el.matches(EDITABLE)) return false;
  if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  return true;
}

const lengthOf = (el: HTMLInputElement | HTMLTextAreaElement): number => el.value.length;

/**
 * Collects privacy-preserving pointer and keyboard behaviour for one attempt. Raw
 * pointer positions and key identities are reduced to counts and timings inside
 * the detectors; only 20 s aggregate windows and named events leave this object.
 */
export function createInputBehaviourCollector(options: InputCollectorOptions) {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const now = options.now ?? (() => performance.now());
  const epoch = options.epoch ?? (() => Date.now());

  const pointer = createPointerMotionAnalyzer();
  const outside = createPointerOutsideTracker();
  const typing = createTypingAnalyzer();
  const keys = createKeyRecorder(typing, now);
  const injection = createInjectionDetector();
  const burst = createBurstAfterIdleDetector(now());
  const drift = createDriftTracker(options.baseline ?? null);

  let windowStartEpoch = epoch();
  let windowStartMono = now();
  let lastPointerAt = now();
  let untrustedOther = 0;
  let contextMenus = 0;
  let selections = 0;
  let selecting = false;
  let injections = 0;
  let idlePointerInjections = 0;
  const lastEmitted = new Map<InputBehaviourEvent, number>();
  const lengths = new WeakMap<EventTarget, number>();

  function emit(event: InputBehaviourEvent): void {
    const t = now();
    const last = lastEmitted.get(event);
    if (last !== undefined && t - last < INPUT_EVENT_GAP_MS) return;
    lastEmitted.set(event, t);
    options.emitEvent(event);
  }

  const focused = (): boolean => !doc.hidden && doc.hasFocus();

  // ── Pointer ────────────────────────────────────────────────────────────────

  const onPointerMove = (e: PointerEvent): void => {
    const t = now();
    if (outside.isOutside) {
      outside.enter(t);
      pointer.breakSegment();
    }
    lastPointerAt = t;
    burst.activity(t);
    pointer.push({ t, x: e.clientX, y: e.clientY, trusted: e.isTrusted });
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (!e.isTrusted) untrustedOther += 1;
    const t = now();
    lastPointerAt = t;
    burst.activity(t);
  };
  const onMouseLeave = (e: MouseEvent): void => {
    if (e.buttons !== 0) return; // dragging a selection past the edge is not leaving
    outside.leave(now(), nearestEdge(e.clientX, e.clientY, win.innerWidth, win.innerHeight));
    pointer.breakSegment();
  };
  const onMouseEnter = (): void => {
    outside.enter(now());
    pointer.breakSegment();
  };
  const onContextMenu = (): void => {
    contextMenus += 1;
  };

  // ── Selection, copy, drop ──────────────────────────────────────────────────

  const onSelectionChange = (): void => {
    const selection = doc.getSelection();
    const active = doc.activeElement;
    const text = selection === null ? '' : selection.toString();
    const onPageText = text.length >= 10 && !isEditable(active);
    if (onPageText && !selecting) selections += 1;
    selecting = onPageText;
  };
  const onCopyOrCut = (): void => {
    const text = doc.getSelection()?.toString() ?? '';
    if (text.length > 0 && !isEditable(doc.activeElement)) emit('copy_question');
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    emit('drop_blocked');
  };
  const onBeforeInput = (e: InputEvent): void => {
    if (e.inputType === 'insertFromDrop' && e.cancelable) {
      e.preventDefault();
      emit('drop_blocked');
    }
  };

  // ── Keyboard and text ──────────────────────────────────────────────────────

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!e.isTrusted) untrustedOther += 1;
    if (!isEditable(e.target)) return;
    const t = now();
    if (keys.keyDown(e) !== null || e.key === 'Tab') injection.keyDown(t);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.keyUp(e);
  };
  const onFocusIn = (e: FocusEvent): void => {
    if (isEditable(e.target)) lengths.set(e.target, lengthOf(e.target));
  };
  const onInput = (e: Event): void => {
    const target = e.target;
    if (!isEditable(target)) return;
    const input = e as InputEvent;
    if (!e.isTrusted) untrustedOther += 1;
    const before = lengths.get(target);
    const after = lengthOf(target);
    lengths.set(target, after);
    const type = input.inputType ?? '';
    // Paste and drop are blocked elsewhere; IME composition, autocorrect and
    // dictation replacement are not typing evidence either way.
    const composing =
      input.isComposing === true ||
      type === 'insertCompositionText' ||
      type === 'insertReplacementText' ||
      type === 'insertFromComposition';
    if (!type.startsWith('insert') || type === 'insertFromPaste' || type === 'insertFromDrop') {
      return;
    }
    const chars =
      type === 'insertText' && typeof input.data === 'string' && input.data.length > 0
        ? input.data.length
        : Math.max(0, after - (before ?? after - 1));
    if (composing || chars <= 0) return;
    const t = now();
    if (burst.chars(t, chars)) emit('burst_after_idle');
    if (injection.insert(t, chars, false)) {
      injections += 1;
      if (t - lastPointerAt > INPUT_THRESHOLDS.pointerIdleMs) idlePointerInjections += 1;
      emit('text_injected');
      options.onInjection?.();
    }
  };

  // ── Focus ──────────────────────────────────────────────────────────────────

  const onFocusLost = (): void => {
    burst.focusBroken();
    typing.breakRun();
    keys.clear();
  };
  const onVisibility = (): void => {
    if (doc.hidden) onFocusLost();
  };

  // ── Windows ────────────────────────────────────────────────────────────────

  function flush(): void {
    const t = now();
    const windowMs = Math.max(1, Math.round(t - windowStartMono));
    const motion = pointer.drain();
    const away = outside.drain(t);
    const typed = typing.drain();
    const reading = drift.observe(typed.sums, windowMs);
    const untrusted = motion.untrusted + untrustedOther;

    if (typed.uniformRhythm || typed.sustainedFast) emit('uniform_typing');
    if (looksSynthetic({ ...motion, untrusted })) emit('synthetic_input');
    if (reading.notice) emit('typing_drift');

    const row: InputBehaviourWindow = {
      windowStart: windowStartEpoch,
      windowMs,
      pointerEvents: motion.events,
      pointerLeaves: away.leaves,
      pointerOutsideMs: away.outsideMs,
      longestOutsideMs: away.longestMs,
      outsideEdge: away.edge,
      untrustedEvents: untrusted,
      teleports: motion.teleports,
      roboticSegments: motion.roboticSegments,
      pathStraightness: motion.straightness,
      velocityCv: motion.velocityCv,
      contextMenus,
      selections,
      keys: typed.keys,
      chars: typed.chars,
      corrections: typed.corrections,
      meanDwellMs: typed.meanDwellMs,
      meanIntervalMs: typed.meanIntervalMs,
      intervalCv: typed.intervalCv,
      wpm: typed.wpm,
      injections,
      idlePointerInjections,
      driftZDwell: reading.drift?.zDwell ?? null,
      driftZInterval: reading.drift?.zInterval ?? null,
    };
    windowStartEpoch = epoch();
    windowStartMono = t;
    untrustedOther = contextMenus = selections = injections = idlePointerInjections = 0;

    const active =
      row.pointerEvents > 0 ||
      row.pointerLeaves > 0 ||
      row.pointerOutsideMs > 0 ||
      row.untrustedEvents > 0 ||
      row.contextMenus > 0 ||
      row.selections > 0 ||
      row.keys > 0 ||
      row.injections > 0;
    if (active) options.flushWindow(row);
  }

  function tick(): void {
    if (outside.check(now(), focused())) emit('pointer_outside_long');
  }

  const capture = { capture: true } as const;
  const passive = { capture: true, passive: true } as const;
  doc.addEventListener('pointermove', onPointerMove, passive);
  doc.addEventListener('pointerdown', onPointerDown, passive);
  doc.documentElement.addEventListener('mouseleave', onMouseLeave);
  doc.documentElement.addEventListener('mouseenter', onMouseEnter);
  doc.addEventListener('contextmenu', onContextMenu, passive);
  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('copy', onCopyOrCut, capture);
  doc.addEventListener('cut', onCopyOrCut, capture);
  doc.addEventListener('drop', onDrop, capture);
  doc.addEventListener('beforeinput', onBeforeInput, capture);
  doc.addEventListener('keydown', onKeyDown, capture);
  doc.addEventListener('keyup', onKeyUp, capture);
  doc.addEventListener('focusin', onFocusIn, capture);
  doc.addEventListener('input', onInput, capture);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('blur', onFocusLost);

  const windowTimer = setInterval(flush, INPUT_WINDOW_MS);
  const tickTimer = setInterval(tick, 1_000);

  return {
    flush,
    tick,
    stop(): void {
      clearInterval(windowTimer);
      clearInterval(tickTimer);
      doc.removeEventListener('pointermove', onPointerMove, passive);
      doc.removeEventListener('pointerdown', onPointerDown, passive);
      doc.documentElement.removeEventListener('mouseleave', onMouseLeave);
      doc.documentElement.removeEventListener('mouseenter', onMouseEnter);
      doc.removeEventListener('contextmenu', onContextMenu, passive);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('copy', onCopyOrCut, capture);
      doc.removeEventListener('cut', onCopyOrCut, capture);
      doc.removeEventListener('drop', onDrop, capture);
      doc.removeEventListener('beforeinput', onBeforeInput, capture);
      doc.removeEventListener('keydown', onKeyDown, capture);
      doc.removeEventListener('keyup', onKeyUp, capture);
      doc.removeEventListener('focusin', onFocusIn, capture);
      doc.removeEventListener('input', onInput, capture);
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('blur', onFocusLost);
      flush();
    },
  };
}
