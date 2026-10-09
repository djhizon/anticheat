import { describe, expect, it, vi } from 'vitest';
import { acquirePhysicalCamera, selectCamera } from './physicalCamera.js';
const device = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: 'videoinput' }) as MediaDeviceInfo;
describe('physical camera preference', () => {
  it('chooses FaceTime over default OBS and other labelled cameras', () => {
    expect(
      selectCamera([
        device('obs', 'OBS Virtual Camera'),
        device('usb', 'USB Camera'),
        device('mac', 'FaceTime HD Camera'),
      ])?.deviceId,
    ).toBe('mac');
  });
  it('does not fall back to virtual or unlabelled devices', () => {
    expect(
      selectCamera([device('obs', 'OBS Virtual Camera'), device('unknown', '')]),
    ).toBeUndefined();
  });
  it('requests the exact physical device and stops an unexpected virtual result', async () => {
    const stop = vi.fn();
    const media = {
      enumerateDevices: vi.fn(async () => [device('mac', 'FaceTime HD')]),
      getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => ({
        getVideoTracks: () => [{ label: 'OBS', getSettings: () => ({ deviceId: 'obs' }) }],
        getTracks: () => [{ stop }],
      })),
    };
    await expect(acquirePhysicalCamera(media as unknown as MediaDevices)).rejects.toThrow(
      'verified',
    );
    expect(media.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      video: { deviceId: { exact: 'mac' } },
    });
    expect(stop).toHaveBeenCalledOnce();
  });
});
