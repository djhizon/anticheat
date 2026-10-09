import { describe, expect, it, vi } from 'vitest';
import { analyseFeed, checkCamera, feedLooksReal } from './cameraGate.js';
import { classifyCameras, selectCamera } from './physicalCamera.js';

const device = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: 'videoinput' }) as MediaDeviceInfo;

const noisy = (seed: number): number[] =>
  Array.from({ length: 256 }, (_, i) => 100 + ((i * 7919 + seed * 104729) % 41) - 20);
const realFrames = [noisy(1), noisy(2), noisy(3), noisy(4), noisy(5)];
const frozenFrames = Array.from({ length: 5 }, () => noisy(1));
const smoothFrames = Array.from({ length: 5 }, (_, k) =>
  Array.from({ length: 256 }, () => 100 + k * 0.01),
);

function fakeMedia(devices: MediaDeviceInfo[], opts: { label?: string; error?: string } = {}) {
  const stop = vi.fn();
  return {
    stop,
    media: {
      enumerateDevices: vi.fn(async () => devices),
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        if (opts.error) throw Object.assign(new Error(opts.error), { name: opts.error });
        const exact = (constraints.video as MediaTrackConstraints | boolean)
          ? (
              (constraints.video as MediaTrackConstraints).deviceId as
                { exact?: string } | undefined
            )?.exact
          : undefined;
        const chosen = devices.find((d) => d.deviceId === exact) ?? devices[0]!;
        return {
          getVideoTracks: () => [
            {
              label: opts.label ?? chosen.label,
              getSettings: () => ({ deviceId: chosen.deviceId }),
            },
          ],
          getTracks: () => [{ stop }],
        };
      }),
    } as unknown as MediaDevices,
  };
}

describe('camera picker', () => {
  it('lists virtual cameras separately and never selects them', () => {
    const devices = [
      device('obs', 'OBS Virtual Camera'),
      device('phone', 'DJ’s Camera'),
      device('mac', 'FaceTime HD Camera (Built-in) (05ac:8514)'),
    ];
    const choices = classifyCameras(devices);
    expect(choices.native.map((d) => d.deviceId)).toEqual(['mac', 'phone']);
    expect(choices.virtual.map((d) => d.deviceId)).toEqual(['obs']);
    expect(selectCamera(devices)?.deviceId).toBe('mac');
    expect(selectCamera(devices, 'phone')?.deviceId).toBe('phone');
    expect(selectCamera(devices, 'obs')?.deviceId).toBe('mac');
  });
});

describe('feed analysis', () => {
  it('accepts sensor-like noise and rejects frozen or smooth synthetic feeds', () => {
    expect(feedLooksReal(realFrames)).toBe(true);
    expect(feedLooksReal(frozenFrames)).toBe(false);
    expect(feedLooksReal(smoothFrames)).toBe(false);
    expect(feedLooksReal([])).toBe(false);
    expect(analyseFeed(frozenFrames)).toEqual({ noise: 0, motion: 0 });
  });
});

describe('camera gate', () => {
  it('blocks with OBS instructions when only virtual cameras exist', async () => {
    const { media } = fakeMedia([device('obs', 'OBS Virtual Camera')]);
    const result = await checkCamera({ media, sample: async () => realFrames });
    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.reason).toBe('only_virtual');
    expect(result.steps.join(' ')).toMatch(/Quit OBS/);
    expect(result.steps.join(' ')).toMatch(/Check again/);
    expect(result.cameras.virtual).toHaveLength(1);
  });

  it('passes with a native camera and live frames, preferring the built-in', async () => {
    const { media } = fakeMedia([
      device('obs', 'OBS Virtual Camera'),
      device('mac', 'FaceTime HD Camera (Built-in)'),
    ]);
    const result = await checkCamera({ media, sample: async () => realFrames });
    expect(result.state).toBe('ok');
    if (result.state === 'ok') expect(result.label).toMatch(/FaceTime/);
  });

  it('blocks and releases the stream when the frames are static', async () => {
    const { media, stop } = fakeMedia([device('mac', 'FaceTime HD Camera')]);
    const result = await checkCamera({ media, sample: async () => frozenFrames });
    expect(result).toMatchObject({ state: 'blocked', reason: 'static_feed' });
    expect(stop).toHaveBeenCalled();
  });

  it('blocks on permission denied with Electron/macOS and browser specific steps', async () => {
    const { media } = fakeMedia([device('mac', 'FaceTime HD Camera')], {
      error: 'NotAllowedError',
    });
    const electron = await checkCamera({
      media,
      userAgent: 'Mozilla/5.0 (Macintosh) Electron/30 Safari',
    });
    expect(electron).toMatchObject({ state: 'blocked', reason: 'permission_denied' });
    if (electron.state === 'blocked')
      expect(electron.steps[0]).toMatch(/System Settings → Privacy & Security → Camera/);
    const browser = await checkCamera({ media, userAgent: 'Mozilla/5.0 (Windows NT 10) Chrome' });
    if (browser.state === 'blocked') expect(browser.steps[0]).toMatch(/address bar/);
  });

  it('reports a camera in use by another app', async () => {
    const { media } = fakeMedia([device('mac', 'FaceTime HD Camera')], {
      error: 'NotReadableError',
    });
    expect(await checkCamera({ media })).toMatchObject({ state: 'blocked', reason: 'in_use' });
  });

  it('reports no camera when none exist', async () => {
    const { media } = fakeMedia([]);
    expect(await checkCamera({ media })).toMatchObject({ state: 'blocked', reason: 'no_camera' });
  });

  it('accepts Chromium’s fake device label when its frames pass (no test exemption)', async () => {
    const { media } = fakeMedia([device('fake', 'fake_device_0')]);
    expect(await checkCamera({ media, sample: async () => realFrames })).toMatchObject({
      state: 'ok',
    });
  });
});
