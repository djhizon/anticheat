import type { EvidenceTrigger } from '@examguard/contracts/exam';

import type { WearableSignal, WearablesSignals } from './wearablesCore.js';

/**
 * Timeline event names (sent as `flag:<name>` via PATCH /events) and the evidence snapshot each
 * confirmed signal asks for. Glasses and watches are ordinary, so they are logged as info only and
 * never photographed; the model cannot tell smart glasses or smartwatches from ordinary ones.
 */
export const WEARABLE_EVENTS: Readonly<
  Record<WearableSignal, { readonly event: string; readonly evidence?: EvidenceTrigger }>
> = {
  earbuds: { event: 'earbuds_detected', evidence: 'earbuds_detected' },
  headphones: { event: 'headphones_detected', evidence: 'headphones_detected' },
  glasses: { event: 'glasses_detected' },
  watch: { event: 'watch_detected' },
  // The browser's fast phone check keeps logging `phone_detected`; this is the detailed model.
  phone: { event: 'phone_detected_detailed', evidence: 'phone_detected' },
  notes: { event: 'notes_detected' },
  extra_person: { event: 'extra_person_detected' },
};

/** A signal that stays on is logged once; it is logged again only after clearing and this gap. */
export const WEARABLE_EVENT_GAP_MS = 60_000;

export interface WearableEvent {
  readonly signal: WearableSignal;
  readonly event: string;
  readonly evidence?: EvidenceTrigger;
}

/** Rising-edge detector: one event per signal when it becomes confirmed (rate-limited). */
export function createWearableEventTracker(gapMs = WEARABLE_EVENT_GAP_MS) {
  const on = new Set<WearableSignal>();
  const lastAt = new Map<WearableSignal, number>();
  return {
    update(signals: WearablesSignals, now: number): WearableEvent[] {
      const out: WearableEvent[] = [];
      for (const [signal, state] of Object.entries(signals) as [
        WearableSignal,
        WearablesSignals[WearableSignal],
      ][]) {
        if (!state.confirmed) {
          on.delete(signal);
          continue;
        }
        if (on.has(signal)) continue;
        on.add(signal);
        const last = lastAt.get(signal);
        if (last !== undefined && now - last < gapMs) continue;
        lastAt.set(signal, now);
        out.push({ signal, ...WEARABLE_EVENTS[signal] });
      }
      return out;
    },
    reset(): void {
      on.clear();
      lastAt.clear();
    },
  };
}
