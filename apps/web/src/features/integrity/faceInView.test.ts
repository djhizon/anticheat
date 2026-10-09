import { describe, expect, it, vi } from 'vitest';

import { readCameraAttestation } from './desktopApps.js';
import {
  FACE_POLL_MS,
  createFaceMonitor,
  evaluateFaceWindow,
  type FaceSample,
  type FaceViewState,
} from './faceInView.js';

const series = (faces: (number | null)[], start = 0): FaceSample[] =>
  faces.map((count, index) => ({ at: start + index * FACE_POLL_MS, faces: count }));

describe('face-in-view window', () => {
  it('needs one face for at least 2 s of the last 3 s', () => {
    const ones = series(Array.from({ length: 12 }, () => 1));
    expect(evaluateFaceWindow(ones.slice(0, 8), 7 * FACE_POLL_MS)).toBe('no_face');
    expect(evaluateFaceWindow(ones.slice(0, 9), 8 * FACE_POLL_MS)).toBe('ok');
    const gappy = series([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(evaluateFaceWindow(gappy, 11 * FACE_POLL_MS)).toBe('no_face');
  });

  it('reports several faces as "multiple" and missing model output as no face', () => {
    expect(evaluateFaceWindow(series([1, 1, 2, 2, 2]), 4 * FACE_POLL_MS)).toBe('multiple');
    expect(evaluateFaceWindow(series([null, null, null, null]), 3 * FACE_POLL_MS)).toBe('no_face');
  });
});

describe('face monitor', () => {
  it('flags darkness, then latches once a face was seen long enough', async () => {
    let now = 0;
    let faces = 0;
    const states: FaceViewState[] = [];
    const source = { faces: vi.fn(async () => faces), close: vi.fn() };
    const monitor = createFaceMonitor({
      source,
      now: () => now,
      luminance: () => 20,
      onChange: (state) => states.push(state),
    });
    await monitor.tick();
    expect(states.at(-1)).toEqual({ phase: 'watching', verdict: 'no_face', dark: true });
    faces = 1;
    for (let i = 0; i < 10; i += 1) {
      now += FACE_POLL_MS;
      await monitor.tick();
    }
    expect(states.at(-1)).toEqual({ phase: 'passed' });
    expect(monitor.passed).toBe(true);
    const calls = source.faces.mock.calls.length;
    await monitor.tick();
    expect(source.faces.mock.calls.length).toBe(calls);
  });
});

describe('desktop camera attestation', () => {
  it('is unknown without the bridge, virtual or ok from its answer', async () => {
    expect(await readCameraAttestation('Cam', {} as never)).toBe('unknown');
    const bridge = (value: unknown) =>
      ({ getCameraAttestation: vi.fn(async () => value) }) as unknown as Parameters<
        typeof readCameraAttestation
      >[1];
    expect(await readCameraAttestation('OBS', bridge({ verdict: 'virtual' }))).toBe('virtual');
    expect(await readCameraAttestation('Cam', bridge({ verdict: 'hardware' }))).toBe('ok');
    expect(await readCameraAttestation('Cam', bridge({ verdict: 'unknown' }))).toBe('unknown');
    expect(await readCameraAttestation('OBS', bridge({ virtual: true }))).toBe('virtual');
    expect(await readCameraAttestation('OBS', bridge({ kind: 'virtual' }))).toBe('virtual');
    expect(await readCameraAttestation('Cam', bridge({ virtual: false }))).toBe('ok');
    expect(await readCameraAttestation('Cam', bridge('nonsense'))).toBe('unknown');
    const failing = {
      getCameraAttestation: vi.fn(async () => {
        throw new Error('ipc');
      }),
    } as unknown as Parameters<typeof readCameraAttestation>[1];
    expect(await readCameraAttestation('Cam', failing)).toBe('unknown');
  });
});
