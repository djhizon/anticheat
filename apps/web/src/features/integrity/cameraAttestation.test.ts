import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTESTATION_TIMEOUT_MS,
  cameraAttestation,
  hardwareCameraText,
  toAttestation,
} from './cameraAttestation.js';

const hardware = {
  verdict: 'hardware',
  kind: 'builtin',
  reasons: ['Built-in camera'],
  matchedDevice: { name: 'FaceTime HD Camera (Built-in)', kind: 'builtin', modelID: 'x' },
};

describe('cameraAttestation bridge', () => {
  afterEach(() => vi.useRealTimers());

  it('is null in a plain browser', () => {
    expect(cameraAttestation({})).toBeNull();
    expect(cameraAttestation({ electronExam: {} })).toBeNull();
    expect(cameraAttestation(undefined)).toBeNull();
  });

  it('passes the label and validates the reply', async () => {
    const bridge = vi.fn(async () => hardware);
    const attest = cameraAttestation({ electronExam: { getCameraAttestation: bridge } })!;
    await expect(attest('FaceTime HD Camera (Built-in) (05ac:8514)')).resolves.toEqual({
      verdict: 'hardware',
      kind: 'builtin',
      reasons: ['Built-in camera'],
      matchedDevice: { name: 'FaceTime HD Camera (Built-in)', kind: 'builtin' },
    });
    expect(bridge).toHaveBeenCalledWith('FaceTime HD Camera (Built-in) (05ac:8514)', {
      refresh: false,
    });
  });

  it('turns errors, bad replies and timeouts into unknown (never a lock-out)', async () => {
    const failing = cameraAttestation({
      electronExam: { getCameraAttestation: async () => Promise.reject(new Error('ipc')) },
    })!;
    expect((await failing('x')).verdict).toBe('unknown');
    expect(toAttestation({ verdict: 'trusted', kind: 'builtin', reasons: [] }).verdict).toBe(
      'unknown',
    );
    expect(toAttestation(null).verdict).toBe('unknown');
    vi.useFakeTimers();
    const hanging = cameraAttestation({
      electronExam: { getCameraAttestation: () => new Promise(() => {}) },
    })!;
    const pending = hanging('x');
    await vi.advanceTimersByTimeAsync(ATTESTATION_TIMEOUT_MS);
    expect((await pending).verdict).toBe('unknown');
  });
});

describe('hardwareCameraText', () => {
  it('names verified hardware and its kind', () => {
    expect(hardwareCameraText(toAttestation(hardware))).toBe(
      'Verified hardware camera: FaceTime HD Camera (Built-in) (built-in)',
    );
    expect(
      hardwareCameraText(
        toAttestation({ ...hardware, kind: 'usb', matchedDevice: { name: 'C920', kind: 'usb' } }),
      ),
    ).toBe('Verified hardware camera: C920 (USB)');
    expect(hardwareCameraText(toAttestation({ ...hardware, verdict: 'unknown' }))).toBeNull();
    expect(hardwareCameraText(undefined)).toBeNull();
  });
});
