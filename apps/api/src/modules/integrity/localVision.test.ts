import { describe, expect, it, vi } from 'vitest';

import { isLoopback } from '../exam/exam.routes.js';
import {
  createLocalVision,
  inferenceThreads,
  LocalVisionBusyError,
  type VisionWorkerLike,
} from './localVision.js';

const O365_LABELS = 366;
const logit = (p: number) => Math.log(p / (1 - p));

/** A scripted stand-in for the worker thread: records messages and lets tests answer them. */
class FakeWorker implements VisionWorkerLike {
  readonly sent: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, ((value: unknown) => void)[]>();
  terminated = false;

  postMessage(value: unknown): void {
    this.sent.push(value as Record<string, unknown>);
  }

  on(event: string, listener: (value: unknown) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  terminate(): void {
    this.terminated = true;
  }

  ready(): void {
    this.emit('message', { type: 'ready' });
  }

  /** Answers the run with id `id` with one earphone (id 208) at 60 % and one person at 90 %. */
  answer(id: number, inferenceMs = 900): void {
    const queries = 2;
    const logits = new Float32Array(queries * O365_LABELS).fill(-12);
    logits[208] = logit(0.6);
    logits[O365_LABELS + 1] = logit(0.9);
    const boxes = Float32Array.from([0.5, 0.5, 0.1, 0.1, 0.5, 0.6, 0.6, 0.8]);
    this.emit('message', {
      type: 'result',
      id,
      logits,
      boxes,
      queries,
      labels: O365_LABELS,
      inferenceMs,
    });
  }
}

function harness(options: { fileExists?: boolean; maxQueued?: number; timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const detector = createLocalVision({
    modelId: 'dfine-x',
    modelDir: '/models',
    threads: 4,
    maxQueued: options.maxQueued ?? 2,
    timeoutMs: options.timeoutMs ?? 30_000,
    fileExists: () => options.fileExists ?? true,
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { detector, workers };
}

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

describe('createLocalVision', () => {
  it('reports unavailable without a model file and never starts a worker', async () => {
    const { detector, workers } = harness({ fileExists: false });
    expect(detector.status()).toEqual({ available: false, model: null });
    await expect(detector.detect(jpeg)).rejects.toThrow('unavailable');
    expect(workers).toHaveLength(0);
  });

  it('warms the worker up on the first status call with the model path and thread count', () => {
    const { detector, workers } = harness();
    expect(detector.status()).toEqual({ available: true, model: 'dfine-x' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent[0]).toEqual({
      type: 'init',
      modelPath: '/models/dfine_x_obj365.onnx',
      threads: 4,
    });
    detector.status();
    expect(workers).toHaveLength(1);
  });

  it('runs one view at a time and decodes the raw outputs into detections', async () => {
    const { detector, workers } = harness();
    const first = detector.detect(jpeg);
    const second = detector.detect(jpeg);
    const worker = workers[0]!;
    // Nothing is sent before the model is ready.
    expect(worker.sent.filter((m) => m.type === 'run')).toHaveLength(0);
    worker.ready();
    expect(worker.sent.filter((m) => m.type === 'run')).toHaveLength(1);
    worker.answer(1);
    const result = await first;
    expect(result.model).toBe('dfine-x');
    expect(result.inferenceMs).toBe(900);
    expect(result.detections.map((d) => [d.cls, d.score.toFixed(2)])).toEqual([
      ['person', '0.90'],
      ['earbuds', '0.60'],
    ]);
    expect(result.detections[1]!.box.x).toBeCloseTo(0.45, 5);
    expect(result.detections[1]!.box.y).toBeCloseTo(0.45, 5);
    // The second request only goes out once the first has been answered.
    expect(worker.sent.filter((m) => m.type === 'run')).toHaveLength(2);
    worker.answer(2);
    await expect(second).resolves.toMatchObject({ inferenceMs: 900 });
  });

  it('refuses more than maxQueued pending views with a busy error', async () => {
    const { detector } = harness({ maxQueued: 1 });
    const pending = detector.detect(jpeg);
    await expect(detector.detect(jpeg)).rejects.toBeInstanceOf(LocalVisionBusyError);
    detector.stop();
    await expect(pending).rejects.toThrow('stopped');
  });

  it('restarts after a stuck run and gives up for good when the model fails to load', async () => {
    vi.useFakeTimers();
    try {
      const { detector, workers } = harness({ timeoutMs: 1000 });
      const stuck = detector.detect(jpeg);
      workers[0]!.ready();
      vi.advanceTimersByTime(1001);
      await expect(stuck).rejects.toThrow('timed out');
      expect(workers[0]!.terminated).toBe(true);
      // The next request spawns a fresh worker.
      const retry = detector.detect(jpeg);
      expect(workers).toHaveLength(2);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      workers[1]!.emit('message', { type: 'error', message: 'bad model' });
      await expect(retry).rejects.toThrow('unavailable');
      expect(detector.status()).toEqual({ available: false, model: null });
      expect(workers).toHaveLength(2);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed worker replies', async () => {
    const { detector, workers } = harness();
    const run = detector.detect(jpeg);
    workers[0]!.ready();
    workers[0]!.emit('message', { type: 'result', id: 1, logits: 'nope' });
    await expect(run).rejects.toThrow('Malformed');
  });
});

describe('inferenceThreads', () => {
  it('uses half the cores, never fewer than two', () => {
    expect(inferenceThreads(16)).toBe(8);
    expect(inferenceThreads(2)).toBe(2);
    expect(inferenceThreads(1)).toBe(2);
  });
});

describe('isLoopback', () => {
  it('accepts only loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.1.2.3')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.10')).toBe(false);
    expect(isLoopback('::ffff:192.168.1.10')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
