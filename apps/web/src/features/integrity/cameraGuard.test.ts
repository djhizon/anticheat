import { describe, expect, it, vi } from 'vitest';
import { startCameraGuard } from './cameraGuard.js';

type Dev = { kind: string; label: string; deviceId: string };

function fakeMedia(initial: Dev[]) {
  const media = new EventTarget() as EventTarget & { enumerateDevices: () => Promise<Dev[]> };
  let devices = initial;
  media.enumerateDevices = vi.fn(async () => devices);
  return {
    media: media as unknown as MediaDevices,
    set: async (d: Dev[]) => {
      devices = d;
      media.dispatchEvent(new Event('devicechange'));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function fakeTrack(label: string, deviceId: string) {
  const t = new EventTarget() as EventTarget & {
    label: string;
    readyState: string;
    getSettings: () => { deviceId: string };
  };
  t.label = label;
  t.readyState = 'live';
  t.getSettings = () => ({ deviceId });
  return t;
}

const cam = (label: string, deviceId: string): Dev => ({ kind: 'videoinput', label, deviceId });

describe('startCameraGuard', () => {
  it('reports a virtual camera once', async () => {
    const m = fakeMedia([cam('Integrated Camera', 'a')]);
    const report = vi.fn();
    startCameraGuard({ media: m.media, report });
    await m.set([cam('Integrated Camera', 'a'), cam('OBS Virtual Camera', 'b')]);
    await m.set([cam('Integrated Camera', 'a'), cam('OBS Virtual Camera', 'b')]);
    expect(report.mock.calls.filter((c) => c[0] === 'virtual_camera_connected')).toHaveLength(1);
  });

  it('reports a capture card', async () => {
    const m = fakeMedia([]);
    const report = vi.fn();
    startCameraGuard({ media: m.media, report });
    await m.set([cam('Elgato Cam Link 4K', 'c')]);
    expect(report).toHaveBeenCalledWith('capture_device_connected');
  });

  it('reports camera_disconnected when the active device disappears', async () => {
    const m = fakeMedia([cam('Integrated Camera', 'a')]);
    const report = vi.fn();
    const track = fakeTrack('Integrated Camera', 'a');
    startCameraGuard({
      media: m.media,
      report,
      getActiveTrack: () => track as unknown as MediaStreamTrack,
    });
    await m.set([]);
    expect(report).toHaveBeenCalledWith('camera_disconnected');
  });

  it('reports camera_swapped_to_virtual when the active track is virtual', async () => {
    const m = fakeMedia([cam('OBS Virtual Camera', 'v')]);
    const report = vi.fn();
    const track = fakeTrack('OBS Virtual Camera', 'v');
    startCameraGuard({
      media: m.media,
      report,
      getActiveTrack: () => track as unknown as MediaStreamTrack,
    });
    await m.set([cam('OBS Virtual Camera', 'v')]);
    expect(report).toHaveBeenCalledWith('camera_swapped_to_virtual');
  });

  it('reports camera_disconnected when the track ends', () => {
    const m = fakeMedia([]);
    const report = vi.fn();
    const track = fakeTrack('Integrated Camera', 'a');
    startCameraGuard({
      media: m.media,
      report,
      getActiveTrack: () => track as unknown as MediaStreamTrack,
    });
    track.dispatchEvent(new Event('ended'));
    track.dispatchEvent(new Event('ended'));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('camera_disconnected');
  });

  it('stops reporting after cleanup', async () => {
    const m = fakeMedia([]);
    const report = vi.fn();
    const track = fakeTrack('Integrated Camera', 'a');
    const stop = startCameraGuard({
      media: m.media,
      report,
      getActiveTrack: () => track as unknown as MediaStreamTrack,
    });
    stop();
    await m.set([cam('OBS Virtual Camera', 'b')]);
    track.dispatchEvent(new Event('ended'));
    expect(report).not.toHaveBeenCalled();
  });
});
