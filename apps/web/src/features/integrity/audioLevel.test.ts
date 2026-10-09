import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLevelMeter } from './audioLevel.js';

const instances: Array<{ close: ReturnType<typeof vi.fn> }> = [];
let frames: Array<(now: number) => void> = [];
let now = 0;

beforeEach(() => {
  instances.length = 0;
  frames = [];
  now = 0;
  class FakeContext {
    close = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    constructor() {
      instances.push(this);
    }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 128,
        getByteFrequencyData: (bins: Uint8Array) => bins.fill(100),
      };
    }
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const runFrame = (advance: number) => {
  now += advance;
  frames.pop()?.(now);
};

it('reports real levels, throttles frames, and releases the AudioContext on stop', () => {
  const onLevel = vi.fn();
  const stop = createLevelMeter({} as MediaStream, onLevel);
  expect(instances).toHaveLength(1);
  runFrame(100);
  expect(onLevel).toHaveBeenCalledOnce();
  expect(onLevel.mock.calls[0]![0].bars).toHaveLength(6);
  expect(onLevel.mock.calls[0]![0].level).toBeCloseTo(0.5);
  runFrame(10); // inside the throttle window
  expect(onLevel).toHaveBeenCalledOnce();
  runFrame(100);
  expect(onLevel).toHaveBeenCalledTimes(2);
  stop();
  expect(instances[0]!.close).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalled();
  runFrame(100);
  expect(onLevel).toHaveBeenCalledTimes(2);
});

it('uses a slower update rate for reduced motion', () => {
  const onLevel = vi.fn();
  createLevelMeter({} as MediaStream, onLevel, true);
  runFrame(300);
  expect(onLevel).toHaveBeenCalledOnce();
  runFrame(100);
  expect(onLevel).toHaveBeenCalledOnce();
  runFrame(200);
  expect(onLevel).toHaveBeenCalledTimes(2);
});

it('never throws when Web Audio is unavailable', () => {
  vi.stubGlobal('AudioContext', function () {
    throw new Error('no audio');
  } as unknown);
  expect(() => createLevelMeter({} as MediaStream, vi.fn())()).not.toThrow();
});
