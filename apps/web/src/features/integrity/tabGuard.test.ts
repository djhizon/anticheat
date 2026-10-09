import { expect, it } from 'vitest';

import { shouldKick, type ViolationEvent, type ViolationType } from './tabGuard.js';

const events = (type: ViolationType, count: number): ViolationEvent[] =>
  Array.from({ length: count }, (_, index) => ({ type, timestamp: index, count: index + 1 }));

it('kicks on the configured threshold for each violation type', () => {
  expect(shouldKick(events('focus_lost', 4))).toBeNull();
  expect(shouldKick(events('focus_lost', 5))?.type).toBe('focus_lost');
  expect(shouldKick(events('duplicate_tab', 1))?.type).toBe('duplicate_tab');
  expect(shouldKick(events('overlay_detected', 1))?.type).toBe('overlay_detected');
});

it('flags bot-like typing without ever kicking', () => {
  expect(shouldKick(events('keystroke_violation', 50))).toBeNull();
});
