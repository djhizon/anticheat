import { describe, expect, it, vi } from 'vitest';
import { acquireBuiltInMicrophone, selectBuiltInMicrophone } from './builtInMicrophone.js';
const device = (deviceId: string, label: string) =>
  ({ kind: 'audioinput', deviceId, label }) as MediaDeviceInfo;
describe('built-in microphone selection', () => {
  it('selects the explicit MacBook input, not the default alias or external devices', () => {
    expect(
      selectBuiltInMicrophone([
        device('default', 'MacBook Pro Microphone'),
        device('usb', 'USB Microphone'),
        device('mac', 'MacBook Pro Microphone'),
      ])?.deviceId,
    ).toBe('mac');
  });
  it.each([
    '',
    'AirPods',
    'iPhone Microphone',
    'BlackHole',
    'USB Built-in Microphone',
    'OBS Virtual MacBook Microphone',
  ])('rejects %s', (label) => {
    expect(selectBuiltInMicrophone([device('x', label)])).toBeUndefined();
  });
  it('does not open a default device to obtain hidden labels', async () => {
    const media = { enumerateDevices: vi.fn(async () => [device('x', '')]), getUserMedia: vi.fn() };
    await expect(acquireBuiltInMicrophone(media as unknown as MediaDevices)).rejects.toThrow(
      'No external/default',
    );
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
  it('requires exact device id and stops an unexpected returned track', async () => {
    const stop = vi.fn();
    const track = { label: 'AirPods', getSettings: () => ({ deviceId: 'wrong' }), stop };
    const media = {
      enumerateDevices: vi.fn(async () => [device('mac', 'Built-in Microphone')]),
      getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
    };
    await expect(acquireBuiltInMicrophone(media as unknown as MediaDevices)).rejects.toThrow(
      'verified',
    );
    expect(media.getUserMedia.mock.calls[0]?.[0].audio).toMatchObject({
      deviceId: { exact: 'mac' },
    });
    expect(stop).toHaveBeenCalledOnce();
  });
  it('returns a verified native track', async () => {
    const track = {
      label: 'MacBook Pro Microphone',
      getSettings: () => ({ deviceId: 'mac' }),
      readyState: 'live',
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const media = {
      enumerateDevices: async () => [device('mac', track.label)],
      getUserMedia: vi.fn(async () => stream),
    };
    expect(await acquireBuiltInMicrophone(media as unknown as MediaDevices)).toBe(stream);
  });
});
