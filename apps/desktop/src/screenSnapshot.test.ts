import { beforeEach, expect, it, vi } from 'vitest';

import {
  captureScreenSnapshot,
  MAX_SNAPSHOT_BYTES,
  MIN_SNAPSHOT_GAP_MS,
  resetScreenSnapshotThrottle,
} from './screenSnapshot.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const deps = (
  thumbnail: { isEmpty(): boolean; toJPEG(q: number): Buffer },
  now = () => 1_000_000,
) => ({
  getSources: vi.fn(async () => [{ display_id: '7', thumbnail }]),
  primaryDisplay: () => ({ id: 7, size: { width: 2880, height: 1800 } }),
  now,
});

beforeEach(() => resetScreenSnapshotThrottle());

it('returns a base64 JPEG downscaled to 640 px wide', async () => {
  const d = deps({ isEmpty: () => false, toJPEG: () => jpeg });
  expect(await captureScreenSnapshot(d)).toBe(jpeg.toString('base64'));
  expect(d.getSources).toHaveBeenCalledWith({
    types: ['screen'],
    thumbnailSize: { width: 640, height: 400 },
    fetchWindowIcons: false,
  });
});

it('returns null for an empty thumbnail (no permission) and for oversized images', async () => {
  expect(await captureScreenSnapshot(deps({ isEmpty: () => true, toJPEG: () => jpeg }))).toBeNull();
  resetScreenSnapshotThrottle();
  const big = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
  expect(await captureScreenSnapshot(deps({ isEmpty: () => false, toJPEG: () => big }))).toBeNull();
});

it('throttles repeated requests', async () => {
  let time = 1_000_000;
  const d = deps({ isEmpty: () => false, toJPEG: () => jpeg }, () => time);
  expect(await captureScreenSnapshot(d)).not.toBeNull();
  time += MIN_SNAPSHOT_GAP_MS - 1;
  expect(await captureScreenSnapshot(d)).toBeNull();
  time += 2;
  expect(await captureScreenSnapshot(d)).not.toBeNull();
});
