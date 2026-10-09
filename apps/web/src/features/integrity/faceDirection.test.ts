import { describe, expect, it } from 'vitest';
import { faceDirection } from './faceDirection.js';
describe('face direction words', () => {
  it('requires calibrated finite readings', () => {
    expect(faceDirection(null)).toBe('Not calibrated');
    expect(faceDirection({ yaw: NaN, pitch: 2 })).toBe('Not calibrated');
  });
  it.each([
    [0, 0, 'Facing forward'],
    [30, 0, 'Facing right →'],
    [-30, 0, 'Facing left ←'],
    [0, 30, 'Facing up ↑'],
    [0, -30, 'Facing down ↓'],
    [-30, 30, 'Facing up ↑ and left ←'],
  ])('labels yaw %s pitch %s', (yaw, pitch, label) =>
    expect(faceDirection({ yaw, pitch })).toBe(label),
  );
});
