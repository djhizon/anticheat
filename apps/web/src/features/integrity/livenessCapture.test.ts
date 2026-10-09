import { expect, it } from 'vitest';

import { centreMeanRgb, meanLuminance } from './livenessCapture.js';
import { median, turnYaw } from './headTurn.js';

it('averages only the centre 50% region of a frame', () => {
  // 4x4 image: outer ring is red 200, centre 2x2 is rgb(10, 20, 30).
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const centre = x >= 1 && x < 3 && y >= 1 && y < 3;
      pixels.set(centre ? [10, 20, 30, 255] : [200, 0, 0, 255], (y * 4 + x) * 4);
    }
  }
  expect(centreMeanRgb(pixels, 4, 4)).toEqual({ r: 10, g: 20, b: 30 });
  expect(centreMeanRgb(new Uint8ClampedArray(0), 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
});

it('computes head-turn yaw relative to the starting pose', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 10])).toBe(2.5);
  expect(turnYaw({ yaw: 30, pitch: 0 }, { yaw: 5, pitch: 0 })).toBe(25);
  expect(turnYaw({ yaw: -170, pitch: 0 }, { yaw: 175, pitch: 0 })).toBe(15);
});
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
