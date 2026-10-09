// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyCamera, type CameraSnapshot } from '../integrity/cameraSession.js';
import {
  base64Jpeg,
  cameraTriggers,
  createEvidenceCapture,
  createEvidenceTracker,
} from './evidenceCapture.js';

const live = (patch: Partial<CameraSnapshot>): CameraSnapshot => ({
  ...emptyCamera(),
  phase: 'live',
  faces: 1,
  ...patch,
});
const JPEG = '/9j/AAAA'; // decodes to FF D8 FF ...

afterEach(() => vi.restoreAllMocks());

describe('cameraTriggers', () => {
  it('maps vision results to triggers and ignores stale or non-live state', () => {
    expect([...cameraTriggers(live({ faces: 2 }))]).toEqual(['multiple_faces']);
    expect([...cameraTriggers(live({ faces: 0 }))]).toEqual(['no_face']);
    expect([...cameraTriggers(live({ phone: 'observed' }))]).toEqual(['phone_detected']);
    expect([...cameraTriggers(live({ phone: 'candidate' }))]).toEqual([]);
    expect([...cameraTriggers(live({ relative: { yaw: 30, pitch: 0 } }))]).toEqual(['look_away']);
    expect([...cameraTriggers(live({ relative: { yaw: 5, pitch: 5 } }))]).toEqual([]);
    expect([...cameraTriggers(live({ faces: null }))]).toEqual([]);
    expect([...cameraTriggers({ ...live({ faces: 2 }), phase: 'off' })]).toEqual([]);
  });

  it('uses eye gaze for look_away when available, head pose otherwise', () => {
    const turnedHead = live({ relative: { yaw: 40, pitch: 0 } });
    // Eyes on screen overrides a turned head; eyes well off screen triggers with a centred head.
    expect([...cameraTriggers(turnedHead, { onScreen: true, offScreenDeg: 0 })]).toEqual([]);
    expect([...cameraTriggers(turnedHead, { onScreen: false, offScreenDeg: 4 })]).toEqual([]);
    expect([
      ...cameraTriggers(live({ relative: { yaw: 0, pitch: 0 } }), {
        onScreen: false,
        offScreenDeg: 14,
      }),
    ]).toEqual(['look_away']);
    expect([...cameraTriggers(turnedHead, null)]).toEqual(['look_away']);
    // Never fires with more than one face or no face for look_away.
    expect([...cameraTriggers(live({ faces: 0 }), { onScreen: false, offScreenDeg: 30 })]).toEqual([
      'no_face',
    ]);
  });
});

describe('stopped capture (camera gate paused)', () => {
  it('takes no snapshots after stop()', async () => {
    const post = vi.fn(async () => undefined);
    let now = 0;
    const capture = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: () => null,
      post,
      now: () => now,
    });
    capture.observeCamera(live({ faces: 3 }));
    capture.stop();
    now += 5000;
    capture.observeCamera(live({ faces: 3 }));
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('createEvidenceTracker', () => {
  it('fires only after the condition holds 2 s, and not again within 30 s', () => {
    let now = 0;
    const tracker = createEvidenceTracker(() => now);
    const on = new Set(['multiple_faces'] as const);
    expect(tracker.update(on)).toEqual([]);
    now = 1900;
    expect(tracker.update(on)).toEqual([]);
    now = 2000;
    expect(tracker.update(on)).toEqual(['multiple_faces']);
    now = 10_000;
    expect(tracker.update(on)).toEqual([]);
    now = 32_000;
    expect(tracker.update(on)).toEqual(['multiple_faces']);
  });

  it('resets when the condition clears (a flicker never fires) and holds look-away for 5 s', () => {
    let now = 0;
    const tracker = createEvidenceTracker(() => now);
    tracker.update(new Set(['no_face']));
    now = 1500;
    tracker.update(new Set());
    now = 3000;
    expect(tracker.update(new Set(['no_face']))).toEqual([]);
    now = 6000;
    expect(tracker.update(new Set(['look_away']))).toEqual([]);
    now = 10_900;
    expect(tracker.update(new Set(['look_away']))).toEqual([]);
    now = 11_000;
    expect(tracker.update(new Set(['look_away']))).toEqual(['look_away']);
  });
});

describe('base64Jpeg', () => {
  it('accepts JPEG data only, within the size cap', () => {
    expect(base64Jpeg(`data:image/jpeg;base64,${JPEG}`)).toBe(JPEG);
    expect(base64Jpeg(JPEG)).toBe(JPEG);
    expect(base64Jpeg('iVBORw0K')).toBeNull(); // PNG
    expect(base64Jpeg('')).toBeNull();
    expect(base64Jpeg(`/9j/${'A'.repeat(420_000)}`)).toBeNull();
  });
});

describe('createEvidenceCapture', () => {
  function video(): HTMLVideoElement {
    const element = document.createElement('video');
    Object.defineProperty(element, 'readyState', { value: 4 });
    Object.defineProperty(element, 'videoWidth', { value: 1280 });
    Object.defineProperty(element, 'videoHeight', { value: 720 });
    return element;
  }
  function stubCanvas() {
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: draw,
    } as unknown as CanvasRenderingContext2D);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue(`data:image/jpeg;base64,${JPEG}`);
    return { draw, toDataURL };
  }

  it('captureNow takes one snapshot immediately for an instantaneous event, rate-limited', async () => {
    stubCanvas();
    const post = vi.fn(async (_id: string, _request: unknown) => undefined);
    let now = 1_000_000;
    const capture = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: () => video(),
      post,
      now: () => now,
    });
    capture.captureNow('text_injected');
    await new Promise((r) => setTimeout(r, 0));
    now += 5000;
    capture.captureNow('text_injected');
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({ source: 'webcam', trigger: 'text_injected' });
  });

  it('captures one downscaled webcam still when a trigger holds and mirrors the server cap', async () => {
    const { draw, toDataURL } = stubCanvas();
    const post = vi.fn(async () => undefined);
    let now = 1_000_000;
    const capture = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: video,
      post,
      now: () => now,
    });
    capture.observeCamera(live({ faces: 3 }));
    expect(post).not.toHaveBeenCalled(); // not held yet
    now += 2000;
    capture.observeCamera(live({ faces: 3 }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('a1', {
      source: 'webcam',
      trigger: 'multiple_faces',
      capturedAt: new Date(now).toISOString(),
      imageJpegBase64: JPEG,
    });
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 360);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6);
    now += 5000;
    capture.observeCamera(live({ faces: 3 }));
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('adds a screen snapshot for overlay events in the desktop app only', async () => {
    stubCanvas();
    const post = vi.fn(async () => undefined);
    const captureScreenSnapshot = vi.fn(async () => JPEG);
    let now = 0;
    const withScreen = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: video,
      post,
      screen: { captureScreenSnapshot },
      now: () => now,
    });
    withScreen.observeEvent('overlay_detected');
    now = 2100;
    withScreen.observeEvent('overlay_detected');
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(
      post.mock.calls.map((call) => (call as unknown as [string, { source: string }])[1].source),
    ).toEqual(['webcam', 'screen']);

    post.mockClear();
    now = 100_000;
    const browserOnly = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: video,
      post,
      now: () => now,
    });
    browserOnly.observeEvent('overlay_detected');
    now += 2100;
    browserOnly.observeEvent('overlay_detected');
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as unknown as [string, { source: string }])[1].source).toBe(
      'webcam',
    );
  });

  it('skips the upload when no frame is available and stops after stop()', async () => {
    const post = vi.fn(async () => undefined);
    let now = 0;
    const capture = createEvidenceCapture({
      attemptId: 'a1',
      getVideo: () => null,
      post,
      now: () => now,
    });
    capture.observeCamera(live({ faces: 0 }));
    now = 3000;
    capture.observeCamera(live({ faces: 0 }));
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    capture.stop();
    stubCanvas();
    const again = createEvidenceCapture({ attemptId: 'a1', getVideo: video, post, now: () => now });
    again.stop();
    again.observeEvent('overlay_detected');
    now += 3000;
    again.observeEvent('overlay_detected');
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });
});
