import { describe, expect, it } from 'vitest';

import {
  createWearablesConfirmation,
  decodeDetections,
  mapToFrame,
  O365_LABEL_COUNT,
  parseDetections,
  signalHit,
  type WearableDetection,
} from './wearablesCore.js';

const logit = (p: number) => Math.log(p / (1 - p));

/** Builds raw D-FINE-shaped outputs with the given (query, label id, score, box) entries. */
function outputs(
  queries: number,
  entries: readonly { q: number; id: number; p: number; box: [number, number, number, number] }[],
) {
  const logits = new Float32Array(queries * O365_LABEL_COUNT).fill(-12);
  const boxes = new Float32Array(queries * 4).fill(0.1);
  for (const { q, id, p, box } of entries) {
    logits[q * O365_LABEL_COUNT + id] = logit(p);
    boxes.set(box, q * 4);
  }
  return { logits, boxes };
}

describe('decodeDetections', () => {
  it('reads only the mapped Objects365 ids and applies per-class floors', () => {
    const { logits, boxes } = outputs(4, [
      { q: 0, id: 208, p: 0.4, box: [0.5, 0.5, 0.1, 0.2] }, // earphone above its 0.35 floor
      { q: 1, id: 8, p: 0.45, box: [0.5, 0.3, 0.4, 0.1] }, // glasses below their 0.5 floor
      { q: 2, id: 2, p: 0.99, box: [0.5, 0.5, 0.5, 0.5] }, // an unrelated category
      { q: 3, id: 62, p: 0.9, box: [0.2, 0.6, 0.2, 0.4] }, // cell phone
    ]);
    const found = decodeDetections(logits, boxes, 4);
    expect(found.map((d) => d.cls)).toEqual(['phone', 'earbuds']);
    expect(found[0]!.score).toBeCloseTo(0.9, 5);
    // (cx, cy, w, h) becomes a top-left box.
    expect(found[0]!.box.x).toBeCloseTo(0.1, 5);
    expect(found[0]!.box.y).toBeCloseTo(0.4, 5);
    expect(found[0]!.box.w).toBeCloseTo(0.2, 5);
  });

  it('merges same-class duplicates and keeps distinct objects', () => {
    const { logits, boxes } = outputs(3, [
      { q: 0, id: 1, p: 0.95, box: [0.3, 0.5, 0.3, 0.8] },
      { q: 1, id: 1, p: 0.8, box: [0.31, 0.5, 0.3, 0.8] }, // same person again
      { q: 2, id: 1, p: 0.85, box: [0.75, 0.5, 0.3, 0.8] }, // a second person
    ]);
    expect(decodeDetections(logits, boxes, 3).map((d) => d.score.toFixed(2))).toEqual([
      '0.95',
      '0.85',
    ]);
  });

  it('returns nothing for truncated outputs', () => {
    expect(decodeDetections(new Float32Array(10), new Float32Array(4), 2)).toEqual([]);
  });
});

describe('mapToFrame and parseDetections', () => {
  it('maps crop coordinates back into the frame', () => {
    const [mapped] = mapToFrame(
      [{ cls: 'earbuds', score: 0.5, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }],
      { x: 0.2, y: 0.1, w: 0.4, h: 0.6 },
    );
    expect(mapped!.box).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.3 });
  });

  it('rejects malformed detections from untrusted sources', () => {
    const good = { cls: 'glasses', score: 0.7, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } };
    expect(parseDetections([good])).toHaveLength(1);
    expect(parseDetections([{ ...good, cls: 'laser' }])).toBeNull();
    expect(parseDetections([{ ...good, score: 2 }])).toBeNull();
    expect(parseDetections([{ ...good, box: { x: 'a', y: 0, w: 1, h: 1 } }])).toBeNull();
    expect(parseDetections('nope')).toBeNull();
  });
});

const det = (cls: WearableDetection['cls'], score = 0.8): WearableDetection => ({
  cls,
  score,
  box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
});

describe('createWearablesConfirmation', () => {
  it('confirms a signal only when two of the last three runs saw it', () => {
    const confirm = createWearablesConfirmation();
    expect(
      confirm.push({ view: 'full', detections: [det('earbuds', 0.6)] }).earbuds.confirmed,
    ).toBe(false);
    expect(confirm.push({ view: 'full', detections: [] }).earbuds.confirmed).toBe(false);
    const third = confirm.push({ view: 'head', detections: [det('earbuds', 0.4)] }).earbuds;
    expect(third).toEqual({ confirmed: true, confidence: 0.5, runs: 3 });
    // The first hit falls out of the window: one of three is not enough.
    expect(confirm.push({ view: 'full', detections: [] }).earbuds.confirmed).toBe(false);
  });

  it('does not let a head crop clear or count toward full-frame-only signals', () => {
    const confirm = createWearablesConfirmation();
    confirm.push({ view: 'full', detections: [det('phone')] });
    confirm.push({ view: 'head', detections: [] });
    confirm.push({ view: 'head', detections: [] });
    const state = confirm.push({ view: 'full', detections: [det('phone')] });
    expect(state.phone).toMatchObject({ confirmed: true, runs: 2 });
    expect(state.notes.runs).toBe(2);
    expect(state.glasses.runs).toBe(4 > 3 ? 3 : 4);
  });

  it('treats two or more people as the extra-person signal', () => {
    expect(
      signalHit({ view: 'full', detections: [det('person', 0.9)] }, 'extra_person'),
    ).toBeNull();
    expect(
      signalHit(
        { view: 'full', detections: [det('person', 0.9), det('person', 0.7)] },
        'extra_person',
      ),
    ).toBe(0.7);
  });

  it('clears all history', () => {
    const confirm = createWearablesConfirmation();
    confirm.push({ view: 'full', detections: [det('glasses')] });
    confirm.clear();
    expect(confirm.state().glasses).toEqual({ confirmed: false, confidence: null, runs: 0 });
  });
});
