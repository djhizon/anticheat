import { describe, expect, it, vi } from 'vitest';
import {
  ATTESTATION_CACHE_MS,
  attestLabel,
  createCameraAttestor,
  nativeUsbId,
  parseBrowserLabel,
  parseCameraList,
  registerCameraAttestation,
  type NativeCamera,
} from './cameraAttestation';

// Shapes copied from the real helper output on an Intel MacBook (FaceTime HD, OBS, iPhone).
const FACETIME: NativeCamera = {
  name: 'FaceTime HD Camera (Built-in)',
  uniqueID: '0x8020000005ac8514',
  modelID: 'UVC Camera VendorID_1452 ProductID_34068',
  manufacturer: 'Apple Inc.',
  deviceType: 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
  transportType: 'usb',
  isConnected: true,
  plugInBundleId: 'com.apple.cmio.uvcassistantextension',
  kind: 'builtin',
  reasons: ['Built-in camera (macOS driver com.apple.cmio.uvcassistantextension, transport usb)'],
};
const OBS: NativeCamera = {
  name: 'OBS Virtual Camera',
  uniqueID: '7626645E-4425-469E-9D8B-97E0FA59AC75',
  modelID: 'OBS Camera Extension',
  manufacturer: 'OBS Project',
  deviceType: 'AVCaptureDeviceTypeExternal',
  transportType: 'virt',
  isConnected: true,
  plugInBundleId: 'com.obsproject.obs-studio.mac-camera-extension',
  kind: 'virtual',
  reasons: ['CoreMediaIO transport type is virtual'],
};
const IPHONE: NativeCamera = {
  name: 'Kwassant Camera',
  uniqueID: 'AA2B0F46-A3B2-4DC6-AC4B-246B00000001',
  modelID: 'iPhone11,8',
  manufacturer: '',
  deviceType: 'AVCaptureDeviceTypeContinuityCamera',
  transportType: 'othr',
  isConnected: true,
  plugInBundleId: 'com.apple.cmio.ContinuityCaptureAgent',
  kind: 'continuity',
  reasons: ['iPhone Continuity Camera'],
};
const LOGITECH: NativeCamera = {
  ...FACETIME,
  name: 'HD Pro Webcam C920',
  uniqueID: '0x14100000046d082d',
  modelID: 'UVC Camera VendorID_1133 ProductID_2093',
  manufacturer: 'Logitech',
  deviceType: 'AVCaptureDeviceTypeExternal',
  kind: 'usb',
  reasons: ['External USB camera'],
};
const ALL = [FACETIME, OBS, IPHONE];

describe('label parsing', () => {
  it('strips the Chromium USB suffix and reads vid:pid', () => {
    expect(parseBrowserLabel('FaceTime HD Camera (Built-in) (05ac:8514)')).toEqual({
      base: 'FaceTime HD Camera (Built-in)',
      usbId: '05ac:8514',
    });
    expect(parseBrowserLabel('HD Pro Webcam C920 (046D:082D)').usbId).toBe('046d:082d');
    expect(parseBrowserLabel('FaceTime HD Camera (Built-in)')).toEqual({
      base: 'FaceTime HD Camera (Built-in)',
      usbId: null,
    });
    expect(parseBrowserLabel('Kwassant Camera').usbId).toBeNull();
  });

  it('derives the native vid:pid from modelID, then uniqueID', () => {
    expect(nativeUsbId(FACETIME)).toBe('05ac:8514');
    expect(nativeUsbId(LOGITECH)).toBe('046d:082d');
    expect(nativeUsbId({ modelID: '', uniqueID: '0x8020000005ac8514' })).toBe('05ac:8514');
    expect(nativeUsbId(OBS)).toBeNull();
    expect(nativeUsbId(IPHONE)).toBeNull();
  });
});

describe('attestLabel', () => {
  it('verifies the built-in camera with and without the USB suffix', () => {
    for (const label of [
      'FaceTime HD Camera (Built-in) (05ac:8514)',
      'FaceTime HD Camera (Built-in)',
    ]) {
      const result = attestLabel(label, ALL);
      expect(result.verdict).toBe('hardware');
      expect(result.kind).toBe('builtin');
      expect(result.matchedDevice?.name).toBe('FaceTime HD Camera (Built-in)');
    }
  });

  it('tolerates case and whitespace differences', () => {
    expect(attestLabel('  facetime hd camera  (built-in) (05AC:8514)', ALL).verdict).toBe(
      'hardware',
    );
  });

  it('marks OBS virtual and an iPhone Continuity Camera as hardware', () => {
    expect(attestLabel('OBS Virtual Camera', ALL)).toMatchObject({
      verdict: 'virtual',
      kind: 'virtual',
    });
    expect(attestLabel('Kwassant Camera', ALL)).toMatchObject({
      verdict: 'hardware',
      kind: 'continuity',
    });
  });

  it('verifies an external USB webcam whose vid:pid matches', () => {
    expect(attestLabel('HD Pro Webcam C920 (046d:082d)', [...ALL, LOGITECH])).toMatchObject({
      verdict: 'hardware',
      kind: 'usb',
    });
  });

  it('treats a mismatched vid:pid as virtual', () => {
    const result = attestLabel('FaceTime HD Camera (Built-in) (046d:082d)', ALL);
    expect(result.verdict).toBe('virtual');
    expect(result.reasons[0]).toMatch(/046d:082d.*05ac:8514/);
  });

  it('blocks a virtual camera that copies a real camera name', () => {
    const fake: NativeCamera = { ...OBS, name: 'FaceTime HD Camera (Built-in)' };
    // Without the suffix the label cannot tell them apart: virtual wins.
    expect(attestLabel('FaceTime HD Camera (Built-in)', [FACETIME, fake]).verdict).toBe('virtual');
    // With the real camera's suffix the real device is identified.
    expect(attestLabel('FaceTime HD Camera (Built-in) (05ac:8514)', [FACETIME, fake]).verdict).toBe(
      'hardware',
    );
    // A virtual camera named with the suffix itself cannot borrow the real camera's verdict.
    const suffixed: NativeCamera = { ...OBS, name: 'FaceTime HD Camera (Built-in) (05ac:8514)' };
    expect(
      attestLabel('FaceTime HD Camera (Built-in) (05ac:8514)', [FACETIME, suffixed]).verdict,
    ).toBe('virtual');
  });

  it('is unknown (not blocked) for unrecognised or missing devices and helper failure', () => {
    expect(attestLabel('Some Capture Card', ALL)).toMatchObject({ verdict: 'unknown' });
    expect(attestLabel('FaceTime HD Camera (Built-in)', null)).toMatchObject({
      verdict: 'unknown',
      matchedDevice: null,
    });
    const odd: NativeCamera = { ...LOGITECH, kind: 'unknown', reasons: ['driver unidentified'] };
    expect(attestLabel('HD Pro Webcam C920 (046d:082d)', [odd])).toMatchObject({
      verdict: 'unknown',
      kind: 'unknown',
      reasons: ['driver unidentified'],
    });
  });

  it('downgrades to unknown when the label carries a USB id macOS does not report', () => {
    const result = attestLabel('Kwassant Camera (05ac:8514)', ALL);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons[0]).toMatch(/05ac:8514/);
  });
});

describe('parseCameraList', () => {
  it('accepts the helper shape and rejects malformed replies', () => {
    expect(parseCameraList({ cameras: ALL })).toHaveLength(3);
    expect(
      parseCameraList({ cameras: [{ ...OBS, plugInBundleId: undefined }] })?.[0]?.plugInBundleId,
    ).toBeNull();
    expect(parseCameraList({ error: 'unavailable' })).toBeNull();
    expect(parseCameraList({ cameras: [{ ...OBS, kind: 'hardware' }] })).toBeNull();
    expect(parseCameraList({ cameras: [{ ...OBS, isConnected: 'yes' }] })).toBeNull();
    expect(parseCameraList(null)).toBeNull();
  });
});

describe('createCameraAttestor', () => {
  it('caches the device list for 10 s and shares in-flight calls', async () => {
    let t = 0;
    const call = vi.fn(async () => ({ cameras: ALL }));
    const attestor = createCameraAttestor({ call, now: () => t });
    await Promise.all([attestor.attest('OBS Virtual Camera'), attestor.attest('Kwassant Camera')]);
    expect(call).toHaveBeenCalledTimes(1);
    t = ATTESTATION_CACHE_MS - 1;
    await attestor.attest('Kwassant Camera');
    expect(call).toHaveBeenCalledTimes(1);
    t = ATTESTATION_CACHE_MS;
    await attestor.attest('Kwassant Camera');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('refreshes on request (rate-limited) and when a label is missing from the cache', async () => {
    let t = 0;
    const call = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ cameras: [FACETIME] })
      .mockResolvedValue({ cameras: ALL });
    const attestor = createCameraAttestor({ call, now: () => t });
    expect((await attestor.attest('FaceTime HD Camera (Built-in)')).verdict).toBe('hardware');
    // OBS appeared after the first run: a cache miss re-runs the helper.
    t = 2000;
    expect((await attestor.attest('OBS Virtual Camera')).verdict).toBe('virtual');
    expect(call).toHaveBeenCalledTimes(2);
    t = 2500; // A refresh within 1 s of the last run reuses it.
    await attestor.attest('OBS Virtual Camera', { refresh: true });
    expect(call).toHaveBeenCalledTimes(2);
    t = 3100;
    await attestor.attest('OBS Virtual Camera', { refresh: true });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    const call = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ cameras: ALL });
    const attestor = createCameraAttestor({ call, now: () => 0 });
    expect((await attestor.attest('OBS Virtual Camera')).verdict).toBe('unknown');
    expect((await attestor.attest('OBS Virtual Camera')).verdict).toBe('virtual');
  });
});

describe('registerCameraAttestation IPC', () => {
  function setup(trusted: boolean) {
    const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
    const call = vi.fn(async () => ({ cameras: ALL }));
    registerCameraAttestation({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      isPackaged: false,
      resourcesPath: '/r',
      appDir: '/a',
      trustedAppFrame: () => trusted,
      call,
    });
    return { handler: handlers.get('camera-attestation')!, call };
  }

  it('answers a trusted app frame', async () => {
    const { handler } = setup(true);
    await expect(handler({} as never, 'OBS Virtual Camera')).resolves.toMatchObject({
      verdict: 'virtual',
    });
  });

  it('refuses untrusted senders without running the helper', () => {
    const { handler, call } = setup(false);
    expect(() => handler({} as never, 'OBS Virtual Camera')).toThrow(/Untrusted/);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects invalid labels', () => {
    const { handler, call } = setup(true);
    for (const label of [undefined, 42, '', '   ', 'x'.repeat(257), { label: 'x' }])
      expect(() => handler({} as never, label)).toThrow(/Invalid/);
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts only an exact { refresh: boolean } request object', async () => {
    const { handler, call } = setup(true);
    await expect(handler({} as never, 'Kwassant Camera', { refresh: true })).resolves.toMatchObject(
      {
        verdict: 'hardware',
      },
    );
    for (const request of [null, true, {}, { refresh: 'yes' }, { refresh: true, extra: 1 }])
      expect(() => handler({} as never, 'Kwassant Camera', request)).toThrow(/Invalid/);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
