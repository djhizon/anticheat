import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCameraContinuity, type ContinuityState } from './cameraContinuity.js';
import type { CameraBlock, CameraGateResult } from './cameraGate.js';

const blockedResult: CameraBlock = {
  state: 'blocked',
  reason: 'only_virtual',
  title: 'virtual',
  steps: ['Quit OBS'],
  cameras: { native: [], virtual: [] },
};
const okResult = (stop = vi.fn()): CameraGateResult => ({
  state: 'ok',
  label: 'FaceTime',
  deviceId: 'mac',
  stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
  cameras: { native: [], virtual: [] },
});

class FakeTrack extends EventTarget {
  readyState = 'live';
  muted = false;
}

describe('mid-exam camera continuity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(results: CameraGateResult[], track: FakeTrack | null = null) {
    const report = vi.fn();
    const states: ContinuityState[] = [];
    const check = vi.fn(async () => results.shift() ?? blockedResult);
    const continuity = createCameraContinuity({
      check,
      report,
      onChange: (s) => states.push(s),
      getTrack: () => track as unknown as MediaStreamTrack | null,
    });
    return { continuity, report, check, states };
  }

  it('pauses on swap-to-virtual, stays paused while blocked, resumes once ok', async () => {
    const stop = vi.fn();
    const { continuity, report, check } = setup([blockedResult, okResult(stop)]);
    continuity.notify('camera_swapped_to_virtual');
    expect(continuity.state().paused).toBe(true);
    expect(report).toHaveBeenCalledWith('camera_feed_paused_virtual_camera');
    await vi.advanceTimersByTimeAsync(0);
    expect(continuity.state()).toMatchObject({ paused: true, block: { reason: 'only_virtual' } });
    // Automatic re-check while paused resumes it.
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(continuity.state()).toMatchObject({ paused: false, epoch: 1 });
    expect(report).toHaveBeenLastCalledWith('camera_feed_resumed');
    expect(stop).toHaveBeenCalled();
    continuity.stop();
  });

  it('pauses on disconnect and on a manual Check again', async () => {
    const { continuity, report } = setup([blockedResult, okResult()]);
    continuity.notify('camera_disconnected');
    expect(report).toHaveBeenCalledWith('camera_feed_paused_disconnected');
    await vi.advanceTimersByTimeAsync(0);
    await continuity.recheck();
    expect(continuity.state().paused).toBe(false);
    continuity.stop();
  });

  it('ignores unrelated guard events', () => {
    const { continuity, report } = setup([]);
    continuity.notify('virtual_camera_connected');
    expect(continuity.state().paused).toBe(false);
    expect(report).not.toHaveBeenCalled();
    continuity.stop();
  });

  it('pauses when the watched track ends', async () => {
    const track = new FakeTrack();
    const { continuity, report } = setup([blockedResult], track);
    await vi.advanceTimersByTimeAsync(1000);
    track.dispatchEvent(new Event('ended'));
    expect(report).toHaveBeenCalledWith('camera_feed_paused_track_ended');
    continuity.stop();
  });

  it('pauses only after the track stays muted for 3 s', async () => {
    const track = new FakeTrack();
    const { continuity, report } = setup([blockedResult], track);
    await vi.advanceTimersByTimeAsync(1000);
    track.muted = true;
    track.dispatchEvent(new Event('mute'));
    await vi.advanceTimersByTimeAsync(2500);
    track.muted = false;
    track.dispatchEvent(new Event('unmute'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(continuity.state().paused).toBe(false);
    track.muted = true;
    track.dispatchEvent(new Event('mute'));
    await vi.advanceTimersByTimeAsync(3100);
    expect(report).toHaveBeenCalledWith('camera_feed_paused_track_muted');
    continuity.stop();
  });
});
