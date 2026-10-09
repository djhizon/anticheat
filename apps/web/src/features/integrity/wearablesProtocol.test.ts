import { describe, expect, it } from 'vitest';

import { parseWorkerReply, parseWorkerRequest, rgbaToChw } from './wearablesProtocol.js';

describe('wearables worker protocol', () => {
  it('accepts a local init request and rejects remote models or odd sizes', () => {
    expect(
      parseWorkerRequest({ type: 'init', modelUrl: '/vision/models/m.onnx', inputSize: 512 }),
    ).toEqual({ type: 'init', modelUrl: '/vision/models/m.onnx', inputSize: 512 });
    expect(
      parseWorkerRequest({ type: 'init', modelUrl: 'https://evil.test/m.onnx', inputSize: 512 }),
    ).toBeNull();
    expect(
      parseWorkerRequest({ type: 'init', modelUrl: '/vision/models/m.onnx', inputSize: 4096 }),
    ).toBeNull();
    expect(parseWorkerRequest(null)).toBeNull();
    expect(parseWorkerRequest({ type: 'shell' })).toBeNull();
  });

  it('rejects detect requests without an image or with a crop outside the frame', () => {
    const crop = { x: 0, y: 0, w: 1, h: 1 };
    // No ImageBitmap in this environment: never accepted.
    expect(
      parseWorkerRequest({ type: 'detect', id: 1, view: 'full', crop, bitmap: {} }),
    ).toBeNull();
    expect(
      parseWorkerRequest({
        type: 'detect',
        id: 1,
        view: 'full',
        crop: { x: 0.5, y: 0, w: 0.7, h: 1 },
        bitmap: {},
      }),
    ).toBeNull();
  });

  it('validates replies before use', () => {
    expect(parseWorkerReply({ type: 'ready', model: 'm' })).toEqual({ type: 'ready', model: 'm' });
    expect(parseWorkerReply({ type: 'error', message: 'x' })).toEqual({
      type: 'error',
      message: 'x',
    });
    expect(parseWorkerReply({ type: 'error', id: 3, message: 'Busy' })).toEqual({
      type: 'error',
      id: 3,
      message: 'Busy',
    });
    const detections = [{ cls: 'earbuds', score: 0.5, box: { x: 0, y: 0, w: 0.1, h: 0.1 } }];
    expect(parseWorkerReply({ type: 'result', id: 1, detections, inferenceMs: 12 })).toEqual({
      type: 'result',
      id: 1,
      detections,
      inferenceMs: 12,
    });
    expect(
      parseWorkerReply({ type: 'result', id: 1, detections: [{ cls: 'x' }], inferenceMs: 1 }),
    ).toBeNull();
    expect(parseWorkerReply({ type: 'result', id: 1, detections, inferenceMs: NaN })).toBeNull();
  });

  it('converts RGBA pixels to planar RGB floats', () => {
    const rgba = [255, 0, 51, 255, 0, 255, 102, 0];
    const [r, g, b] = Array.from(rgbaToChw(rgba, 1).slice(0, 3));
    expect(r).toBe(1);
    expect(g).toBe(0);
    expect(b).toBeCloseTo(0.2, 5); // float32 storage
    const two = rgbaToChw([...rgba, ...rgba], 2);
    expect(two).toHaveLength(12);
    expect(two[1]).toBe(0); // second pixel, red plane
    expect(two[4 + 1]).toBe(1); // second pixel, green plane
  });
});
