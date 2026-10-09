import { expect, it } from 'vitest';

import { meanLuminance } from './livenessCapture.js';
import { selectCamera } from './physicalCamera.js';

it('measures mean perceived luminance of RGBA pixels', () => {
  expect(meanLuminance(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]))).toBe(0);
  expect(meanLuminance(new Uint8ClampedArray([255, 255, 255, 255]))).toBeCloseTo(255);
  expect(
    meanLuminance(new Uint8ClampedArray([100, 100, 100, 255, 200, 200, 200, 255])),
  ).toBeCloseTo(150);
});

it('never selects OBS or phone-as-webcam virtual sources', () => {
  const camera = (label: string) =>
    ({ kind: 'videoinput', label, deviceId: label }) as MediaDeviceInfo;
  const virtualOnly = [
    'OBS Virtual Camera',
    'Camo',
    'DroidCam Source 3',
    'iVCam',
    'XSplit VCam',
    'mmhmm Camera',
    'NVIDIA Broadcast',
  ].map(camera);
  expect(selectCamera(virtualOnly)).toBeUndefined();
  expect(selectCamera([...virtualOnly, camera('FaceTime HD Camera')])?.label).toBe(
    'FaceTime HD Camera',
  );
});
