import { describe, expect, it, vi } from 'vitest';
import { tuneCameraTrack } from './cameraTuning.js';

function track(capabilities: Record<string, unknown> | null, rejectOn?: string) {
  const applyConstraints = vi.fn(async (constraints: MediaTrackConstraints) => {
    const name = Object.keys(constraints.advanced?.[0] ?? {})[0];
    if (name === rejectOn) throw new Error('OverconstrainedError');
  });
  return {
    track: {
      getCapabilities: capabilities === null ? undefined : () => capabilities,
      applyConstraints,
    } as unknown as MediaStreamTrack,
    applyConstraints,
  };
}

describe('camera tuning', () => {
  it('does nothing when the camera exposes no capabilities (typical macOS Chrome)', async () => {
    expect(await tuneCameraTrack(undefined)).toEqual({ applied: [], supported: false });
    const bare = track(null);
    expect(await tuneCameraTrack(bare.track)).toEqual({ applied: [], supported: false });
    const empty = track({});
    expect(await tuneCameraTrack(empty.track, { dim: true })).toEqual({
      applied: [],
      supported: false,
    });
    expect(empty.applyConstraints).not.toHaveBeenCalled();
  });

  it('applies continuous exposure and, when dim, a higher exposure compensation and brightness', async () => {
    const { track: t, applyConstraints } = track({
      exposureMode: ['manual', 'continuous'],
      whiteBalanceMode: ['continuous'],
      exposureCompensation: { min: -2, max: 2, step: 0.5 },
      brightness: { min: 0, max: 100, step: 1 },
    });
    const result = await tuneCameraTrack(t, { dim: true });
    expect(result.applied).toEqual([
      'exposureMode',
      'whiteBalanceMode',
      'exposureCompensation',
      'brightness',
    ]);
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ exposureCompensation: 1 }] });
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ brightness: 65 }] });
  });

  it('skips exposure compensation and brightness when the light is not dim', async () => {
    const { track: t } = track({
      exposureMode: ['continuous'],
      exposureCompensation: { min: -2, max: 2, step: 0.5 },
    });
    expect((await tuneCameraTrack(t)).applied).toEqual(['exposureMode']);
  });

  it('ignores a rejected constraint and keeps the others', async () => {
    const { track: t } = track(
      {
        exposureMode: ['continuous'],
        brightness: { min: 0, max: 10, step: 1 },
      },
      'exposureMode',
    );
    expect(await tuneCameraTrack(t, { dim: true })).toEqual({
      applied: ['brightness'],
      supported: true,
    });
  });
});
