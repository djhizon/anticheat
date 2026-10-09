import { EVIDENCE_TRIGGERS } from '@examguard/contracts/exam';
import { describe, expect, it } from 'vitest';

import { emptySignals, type WearableSignal, type WearablesSignals } from './wearablesCore.js';
import { createWearableEventTracker, WEARABLE_EVENTS } from './wearablesEvents.js';

function signals(on: readonly WearableSignal[]): WearablesSignals {
  const state = { ...emptySignals() };
  for (const signal of on) state[signal] = { confirmed: true, confidence: 0.7, runs: 3 };
  return state;
}

describe('wearable events', () => {
  it('maps signals to non-accusatory events; only earbuds/headphones/phone take photos', () => {
    expect(WEARABLE_EVENTS.earbuds).toEqual({
      event: 'earbuds_detected',
      evidence: 'earbuds_detected',
    });
    expect(WEARABLE_EVENTS.headphones.evidence).toBe('headphones_detected');
    expect(WEARABLE_EVENTS.glasses).toEqual({ event: 'glasses_detected' });
    expect(WEARABLE_EVENTS.watch.evidence).toBeUndefined();
    for (const { evidence } of Object.values(WEARABLE_EVENTS)) {
      if (evidence !== undefined) expect(EVIDENCE_TRIGGERS).toContain(evidence);
    }
  });

  it('fires once on the rising edge and again only after clearing and the gap', () => {
    const tracker = createWearableEventTracker(60_000);
    expect(tracker.update(signals(['earbuds', 'glasses']), 0).map((e) => e.event)).toEqual([
      'earbuds_detected',
      'glasses_detected',
    ]);
    expect(tracker.update(signals(['earbuds', 'glasses']), 5_000)).toEqual([]);
    tracker.update(signals([]), 10_000);
    // Re-confirmed too soon: suppressed (and not re-armed until it clears again).
    expect(tracker.update(signals(['earbuds']), 20_000)).toEqual([]);
    tracker.update(signals([]), 70_000);
    expect(tracker.update(signals(['earbuds']), 80_000)).toEqual([
      { signal: 'earbuds', event: 'earbuds_detected', evidence: 'earbuds_detected' },
    ]);
  });

  it('forgets everything on reset', () => {
    const tracker = createWearableEventTracker();
    tracker.update(signals(['headphones']), 0);
    tracker.reset();
    expect(tracker.update(signals(['headphones']), 1)).toHaveLength(1);
  });
});
