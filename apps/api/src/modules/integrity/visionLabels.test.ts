import { describe, expect, it } from 'vitest';
import { friendlyVisionLabel, isFlaggableVisionLabel, visionFlagName } from './visionLabels.js';

describe('vision labels', () => {
  it('builds flag names and maps them back to friendly names', () => {
    expect(visionFlagName('smart watch')).toBe('vision_smart_watch');
    expect(friendlyVisionLabel('smart_watch')).toBe('smartwatch');
    expect(friendlyVisionLabel('smart_glasses')).toBe('smart glasses');
    expect(friendlyVisionLabel('cell_phone')).toBe('mobile phone');
    expect(friendlyVisionLabel('earbuds')).toBe('earbuds');
    expect(friendlyVisionLabel('headset')).toBe('headset');
    expect(friendlyVisionLabel('mystery_item')).toBe('mystery item');
  });

  it('flags the device labels but never "person" or unknown labels', () => {
    for (const label of [
      'cell phone',
      'earbuds',
      'headphones',
      'headset',
      'smart glasses',
      'smart watch',
    ]) {
      expect(isFlaggableVisionLabel(label)).toBe(true);
    }
    expect(isFlaggableVisionLabel('person')).toBe(false);
    expect(isFlaggableVisionLabel('toString')).toBe(false);
  });
});
