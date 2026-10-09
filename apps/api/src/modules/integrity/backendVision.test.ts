import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisionClient } from './backendVision.js';

function fakeServer() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: string[] = [];
  stdin.on('data', (chunk: Buffer) =>
    requests.push(...chunk.toString().split('\n').filter(Boolean)),
  );
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() });
  return { child: child as ChildProcess, stdout, requests };
}

describe('vision server bridge', () => {
  afterEach(() => vi.useRealTimers());

  it('queues overlapping requests and answers them in order', async () => {
    const server = fakeServer();
    const client = new VisionClient(() => server.child);
    const first = client.detect('a');
    const second = client.detect('b');
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
    vi.advanceTimersByTime(1000);
    await expect(stuck).rejects.toThrow('timed out');
    expect(server.child.kill).toHaveBeenCalled();
  });
});
