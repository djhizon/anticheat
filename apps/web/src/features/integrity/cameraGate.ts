import { VIRTUAL_CAMERA_LABEL } from '@exam-anti-cheat/contracts/exam';
import { acquirePhysicalCamera, classifyCameras, type CameraChoices } from './physicalCamera.js';

/** One luminance sample (64x64 by default) of the live feed. */
export type FeedFrame = ArrayLike<number>;

export type CameraBlockReason =
  'only_virtual' | 'no_camera' | 'permission_denied' | 'in_use' | 'static_feed' | 'unverified';

export interface CameraBlock {
  readonly state: 'blocked';
  readonly reason: CameraBlockReason;
  readonly title: string;
  readonly steps: readonly string[];
  readonly cameras: CameraChoices;
}

export interface CameraOk {
  readonly state: 'ok';
  readonly label: string;
  readonly deviceId: string;
  /** Live stream; the caller owns it and must stop it. */
  readonly stream: MediaStream;
  readonly cameras: CameraChoices;
}

export type CameraGateResult = CameraOk | CameraBlock;

/** Temporal noise of real sensors is ~15-40; virtual/looped/static feeds are ~0.3-2. */
export const MIN_NOISE_VARIANCE = 2;
/** Below this mean absolute frame-to-frame change the picture is frozen. */
export const MIN_MOTION = 0.3;

export interface FeedAnalysis {
  readonly noise: number;
  readonly motion: number;
}

/** Median per-pair variance of the luminance difference, and the largest mean change. */
export function analyseFeed(frames: readonly FeedFrame[]): FeedAnalysis {
  const variances: number[] = [];
  let maxMotion = 0;
  for (let f = 1; f < frames.length; f += 1) {
    const a = frames[f - 1]!;
    const b = frames[f]!;
    const n = Math.min(a.length, b.length);
    if (n === 0) continue;
    let sum = 0;
    let sumSq = 0;
    let abs = 0;
    for (let i = 0; i < n; i += 1) {
      const diff = b[i]! - a[i]!;
      sum += diff;
      sumSq += diff * diff;
      abs += Math.abs(diff);
    }
    const mean = sum / n;
    variances.push(sumSq / n - mean * mean);
    maxMotion = Math.max(maxMotion, abs / n);
  }
  if (variances.length === 0) return { noise: 0, motion: 0 };
  variances.sort((x, y) => x - y);
  return { noise: variances[Math.floor(variances.length / 2)]!, motion: maxMotion };
}

export function feedLooksReal(frames: readonly FeedFrame[]): boolean {
  if (frames.length < 3) return false;
  const { noise, motion } = analyseFeed(frames);
  return motion >= MIN_MOTION && noise >= MIN_NOISE_VARIANCE;
}

/** Captures ~1.5 s of the stream (6 frames, 250 ms apart) as small luminance arrays. */
export async function sampleFeed(
  stream: MediaStream,
  frames = 6,
  intervalMs = 250,
): Promise<FeedFrame[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    const deadline = Date.now() + 3000;
    while (video.readyState < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    if (video.readyState < 2) return [];
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    const out: FeedFrame[] = [];
    for (let k = 0; k < frames; k += 1) {
      if (k > 0) await new Promise((r) => setTimeout(r, intervalMs));
      ctx.drawImage(video, 0, 0, 64, 64);
      const px = ctx.getImageData(0, 0, 64, 64).data;
      const lum = new Float32Array(64 * 64);
      for (let i = 0; i < lum.length; i += 1)
        lum[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
      out.push(lum);
    }
    return out;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export interface CameraGateOptions {
  readonly media?: MediaDevices;
  readonly preferredId?: string;
  /** Injectable for tests; defaults to a real 1.5 s canvas sample. */
  readonly sample?: (stream: MediaStream) => Promise<readonly FeedFrame[]>;
  /** Injectable for tests; defaults to the browser user agent. */
  readonly userAgent?: string;
}

const NO_CAMERAS: CameraChoices = { native: [], virtual: [] };

function permissionSteps(userAgent: string): string[] {
  if (/Electron/i.test(userAgent))
    return [
      'Open System Settings → Privacy & Security → Camera.',
      'Turn on the switch next to this exam app, then fully quit and reopen the app.',
      'Sign back in, open the exam, and press Check again.',
    ];
  if (/Mac/i.test(userAgent))
    return [
      'Click the camera/lock icon at the left of the address bar and set Camera to Allow.',
      'If it is still blocked: System Settings → Privacy & Security → Camera, and turn on your browser.',
      'Reload this page (the browser may ask you to relaunch), then press Check again.',
    ];
  return [
    'Click the camera/lock icon at the left of the address bar and set Camera to Allow.',
    'Check your operating system privacy settings allow the browser to use the camera.',
    'Reload this page, then press Check again.',
  ];
}

const VIRTUAL_STEPS = [
  'Quit OBS completely (or at least turn off "Start Virtual Camera").',
  'Close Camo, DroidCam, Snap Camera, Iriun, ManyCam, mmhmm and any other camera app.',
  'Make sure your built-in webcam is not disabled or covered, then press Check again.',
];

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? String((error as { name?: unknown }).name ?? '')
    : '';
}

/**
 * The camera gate: acquire a real native camera, then verify the live frames
 * look like a sensor (noise) and are not frozen or looped. Never throws.
 */
export async function checkCamera(options: CameraGateOptions = {}): Promise<CameraGateResult> {
  const media = options.media ?? navigator.mediaDevices;
  const userAgent =
    options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const sample = options.sample ?? ((stream: MediaStream) => sampleFeed(stream));
  let cameras = NO_CAMERAS;
  const blocked = (
    reason: CameraBlockReason,
    title: string,
    steps: readonly string[],
  ): CameraBlock => ({ state: 'blocked', reason, title, steps, cameras });
  const fromError = (error: unknown): CameraBlock => {
    const name = errorName(error);
    if (name === 'NotAllowedError' || name === 'SecurityError')
      return blocked(
        'permission_denied',
        'Camera permission is blocked',
        permissionSteps(userAgent),
      );
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
      return blocked('in_use', 'Your camera is being used by another app', [
        'Close Zoom, Teams, Meet, FaceTime, Photo Booth, OBS and any other app or tab using the camera.',
        'If you are unsure which one, quit those apps completely (Cmd+Q on Mac).',
        'Press Check again.',
      ]);
    if (error instanceof Error && /could not be verified/i.test(error.message))
      return blocked(
        'unverified',
        'The camera could not be verified as a real webcam',
        VIRTUAL_STEPS,
      );
    return blocked('no_camera', 'No usable webcam was found', [
      'Make sure your built-in webcam is enabled and nothing covers it.',
      'If you use an external webcam, unplug it and plug it in again.',
      'Press Check again.',
    ]);
  };

  try {
    let devices = await media.enumerateDevices();
    if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
      // Labels are hidden until camera permission is granted.
      const probe = await media.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach((track) => track.stop());
      devices = await media.enumerateDevices();
    }
    cameras = classifyCameras(devices);
    if (cameras.native.length === 0) {
      if (cameras.virtual.length > 0)
        return blocked(
          'only_virtual',
          `Only virtual cameras were found (${cameras.virtual.map((d) => d.label).join(', ')})`,
          VIRTUAL_STEPS,
        );
      return fromError(new Error('no camera'));
    }
    const stream = await acquirePhysicalCamera(media, options.preferredId);
    const track = stream.getVideoTracks()[0];
    const label = track?.label ?? '';
    const deviceId = track?.getSettings().deviceId ?? '';
    if (VIRTUAL_CAMERA_LABEL.test(label)) {
      stream.getTracks().forEach((t) => t.stop());
      return blocked('only_virtual', 'The camera in use is a virtual camera', VIRTUAL_STEPS);
    }
    // No test exemption: Chromium's fake device (noise ~600, motion ~8) passes this check itself.
    let frames: readonly FeedFrame[] = [];
    try {
      frames = await sample(stream);
    } catch {
      frames = [];
    }
    if (!feedLooksReal(frames)) {
      stream.getTracks().forEach((t) => t.stop());
      return blocked('static_feed', 'The camera picture looks frozen or synthetic', [
        'Make sure the lens is uncovered and the room is lit.',
        'Turn off any camera effects, filters, or video-loop apps (OBS, Camo, Snap Camera, ManyCam).',
        'If the picture is stuck, unplug and replug an external webcam or restart the browser, then press Check again.',
      ]);
    }
    return { state: 'ok', label, deviceId, stream, cameras };
  } catch (error) {
    return fromError(error);
  }
}
