import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisionClient, visionPython } from './backendVision.js';

function fakeServer() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: string[] = [];
  stdin.on('data', (chunk: Buffer) =>
    requests.push(...chunk.toString().split('\n').filter(Boolean)),
  );
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn() });
  // The Python server prints READY on stderr once the model has loaded.
  const ready = () => stderr.write('Loading OWL-ViT massive vision model...\nREADY\n');
  return { child: child as ChildProcess, stdout, requests, ready };
}

describe('vision server bridge', () => {
  afterEach(() => vi.useRealTimers());

  it('queues overlapping requests and answers them in order', async () => {
    const server = fakeServer();
    const client = new VisionClient(() => server.child);
    const first = client.detect('a');
    const second = client.detect('b');
    server.ready();
    await vi.waitFor(() => expect(server.requests).toHaveLength(2));
    expect(JSON.parse(server.requests[0]!)).toEqual({ image_base64: 'a' });

    // One chunk that splits the second response across writes.
    server.stdout.write('{"status":"ok","detections":[]}\n{"status":"ok","detec');
    server.stdout.write('tions":[{"label":"cell phone","score":0.9}]}\n');

    await expect(first).resolves.toEqual({ status: 'ok', detections: [] });
    await expect(second).resolves.toMatchObject({ detections: [{ label: 'cell phone' }] });
  });

  it('rejects pending requests and restarts after the server exits', async () => {
    const servers = [fakeServer(), fakeServer()];
    const spawn = vi.fn(() => servers[spawn.mock.calls.length - 1]!.child);
    const client = new VisionClient(spawn);
    const pending = client.detect('a');
    servers[0]!.child.emit('exit', 1);
    await expect(pending).rejects.toThrow('exited');

    const retried = client.detect('b');
    servers[1]!.ready();
    await vi.waitFor(() => expect(servers[1]!.requests).toHaveLength(1));
    servers[1]!.stdout.write('{"status":"ok","detections":[]}\n');
    await expect(retried).resolves.toMatchObject({ status: 'ok' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('times out a stuck request and bounds the queue', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const client = new VisionClient(() => server.child, 1000, 1);
    const stuck = client.detect('a');
    await expect(client.detect('b')).rejects.toThrow('busy');
    server.ready();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);
    await expect(stuck).rejects.toThrow('timed out');
    expect(server.child.kill).toHaveBeenCalled();
  });

  it('holds requests unsent and untimed while the model loads', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const client = new VisionClient(() => server.child, 1000, 4, 60000);
    const pending = client.detect('a');
    await vi.advanceTimersByTimeAsync(30000); // far past the request timeout
    expect(server.requests).toHaveLength(0);

    server.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests).toHaveLength(1);
    server.stdout.write('{"status":"ok","detections":[]}\n');
    await expect(pending).resolves.toMatchObject({ status: 'ok' });
  });

  it('gives up when the model never finishes loading', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const client = new VisionClient(() => server.child, 1000, 4, 60000);
    const pending = client.detect('a');
    vi.advanceTimersByTime(60000);
    await expect(pending).rejects.toThrow('did not finish loading');
    expect(server.child.kill).toHaveBeenCalled();
  });

  it('prefers VISION_PYTHON, then the setup venv, then python3', () => {
    expect(visionPython({ VISION_PYTHON: '/opt/py' }, true)).toBe('/opt/py');
    expect(visionPython({}, true)).toMatch(/vendor\/venv\/bin\/python$/u);
    expect(visionPython({}, false)).toBe('python3');
  });
});
