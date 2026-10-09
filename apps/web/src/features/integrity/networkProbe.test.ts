// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  PROFILES,
  applyConnectionHint,
  chooseProfile,
  probeUploadKbps,
  stepDown,
  stepUp,
} from './networkProbe.js';

it('chooses profiles at the documented upload thresholds', () => {
  expect(chooseProfile(null)).toBe('local-only');
  expect(chooseProfile(0)).toBe('local-only');
  expect(chooseProfile(Number.NaN)).toBe('local-only');
  expect(chooseProfile(100)).toBe('low');
  expect(chooseProfile(2499)).toBe('low');
  expect(chooseProfile(2500)).toBe('standard');
  expect(chooseProfile(5999)).toBe('standard');
  expect(chooseProfile(6000)).toBe('high');
  expect(chooseProfile(50_000)).toBe('high');
});

it('keeps each profile bitrate within 25% of the upload that selects it', () => {
  expect(PROFILES.high.videoBitsPerSecond / 1000).toBeLessThanOrEqual(
    PROFILES.high.minUploadKbps * 0.25,
  );
  expect(PROFILES.standard.videoBitsPerSecond / 1000).toBeLessThanOrEqual(
    PROFILES.standard.minUploadKbps * 0.25,
  );
});

it('steps profiles one at a time and the hint only lowers quality', () => {
  expect(stepDown('high')).toBe('standard');
  expect(stepDown('low')).toBe('low');
  expect(stepUp('low')).toBe('standard');
  expect(stepUp('high')).toBe('high');
  expect(applyConnectionHint('high', { effectiveType: '3g' })).toBe('low');
  expect(applyConnectionHint('standard', { effectiveType: '4g' })).toBe('standard');
  expect(applyConnectionHint('local-only', { effectiveType: '4g' })).toBe('local-only');
});

it('measures the faster upload sample and tolerates failed samples', async () => {
  let clock = 0;
  const durations = [2000, 1000];
  const speedtest = vi.fn(async () => {
    clock += durations.shift() ?? 1;
  });
  const kbps = await probeUploadKbps({ speedtest }, { now: () => clock });
  // 1 MiB chars in 1 s is about 8389 kbps.
  expect(kbps).toBeGreaterThan(8000);
  expect(speedtest).toHaveBeenCalledTimes(2);
  expect(
    await probeUploadKbps({ speedtest: async () => Promise.reject(new Error('x')) }),
  ).toBeNull();
});
