import {
  INPUT_THRESHOLDS,
  createTypingAnalyzer,
  profileFromSums,
  type TypingProfile,
} from './inputDetectors.js';
import { createKeyRecorder } from './keyRecorder.js';

const STORAGE_KEY = 'exam.typingBaseline.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Reads the profile saved during pre-exam setup typing, or null (never throws). */
export function loadTypingBaseline(storage?: StorageLike): TypingProfile | null {
  try {
    const raw = (storage ?? sessionStorage).getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const p = value as Record<string, unknown>;
    if (
      !isFiniteNumber(p.n) ||
      !isFiniteNumber(p.meanDwellMs) ||
      !isFiniteNumber(p.sdDwellMs) ||
      !isFiniteNumber(p.nInterval) ||
      !isFiniteNumber(p.meanIntervalMs) ||
      !isFiniteNumber(p.sdIntervalMs)
    ) {
      return null;
    }
    return {
      n: p.n,
      meanDwellMs: p.meanDwellMs,
      sdDwellMs: p.sdDwellMs,
      nInterval: p.nInterval,
      meanIntervalMs: p.meanIntervalMs,
      sdIntervalMs: p.sdIntervalMs,
    };
  } catch {
    return null;
  }
}

export function saveTypingBaseline(profile: TypingProfile, storage?: StorageLike): void {
  try {
    (storage ?? sessionStorage).setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage may be unavailable; the exam then learns a baseline from its first minutes.
  }
}

/**
 * Hook-in for the pre-exam setup screen: call when setup starts, and call the returned
 * function when it ends. Typing rhythm statistics (means and spreads, no keys, no text)
 * are saved for the exam page to compare against. Returns the profile, or null when
 * too little was typed to be meaningful.
 */
export function startSetupTypingCapture(
  doc: Document = document,
  storage?: StorageLike,
): () => TypingProfile | null {
  const analyzer = createTypingAnalyzer();
  const recorder = createKeyRecorder(analyzer);
  const onDown = (e: KeyboardEvent) => {
    recorder.keyDown(e);
  };
  const onUp = (e: KeyboardEvent) => recorder.keyUp(e);
  doc.addEventListener('keydown', onDown, true);
  doc.addEventListener('keyup', onUp, true);
  let done = false;
  return () => {
    if (!done) {
      done = true;
      doc.removeEventListener('keydown', onDown, true);
      doc.removeEventListener('keyup', onUp, true);
    }
    const profile = profileFromSums(analyzer.drain().sums);
    if (profile !== null && profile.n >= INPUT_THRESHOLDS.baselineMinKeys) {
      saveTypingBaseline(profile, storage);
    }
    return profile;
  };
}
