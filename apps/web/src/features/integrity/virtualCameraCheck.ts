/** Known virtual camera software labels */
const VIRTUAL_CAM_LABELS = [
  'obs', 'manycam', 'xsplit', 'vcam', 'snap camera', 'mmhmm',
  'virtual', 'fake', 'loopback', 'ndi', 'droidcam', 'iriun'
];

export interface VirtualCamCheck {
  readonly isVirtual: boolean;
  readonly reason: string;
  readonly label: string;
}

export function checkForVirtualCamera(track: MediaStreamTrack): VirtualCamCheck {
  const label = track.label.toLowerCase();
  const match = VIRTUAL_CAM_LABELS.find((v) => label.includes(v));
  if (match) {
    return { isVirtual: true, reason: `Camera label contains "${match}"`, label: track.label };
  }
  return { isVirtual: false, reason: 'Camera label appears genuine', label: track.label };
}

/**
 * Measures frame noise variance to detect virtual/pre-recorded feeds.
 * Returns variance value — real cameras: ~15-40, virtual cams: ~0.3-2.
 */
export async function measureFrameNoise(video: HTMLVideoElement): Promise<number> {
  const canvas = document.createElement('canvas');
  canvas.width = 64; // small sample
  canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;

  // Sample 2 frames 200ms apart
  ctx.drawImage(video, 0, 0, 64, 64);
  const frame1 = ctx.getImageData(0, 0, 64, 64).data;
  await new Promise((r) => setTimeout(r, 200));
  ctx.drawImage(video, 0, 0, 64, 64);
  const frame2 = ctx.getImageData(0, 0, 64, 64).data;

  // Compute per-pixel luminance difference variance
  let sum = 0;
  let sumSq = 0;
  const n = frame1.length / 4;
  for (let i = 0; i < frame1.length; i += 4) {
    const lum1 = 0.299 * frame1[i]! + 0.587 * frame1[i + 1]! + 0.114 * frame1[i + 2]!;
    const lum2 = 0.299 * frame2[i]! + 0.587 * frame2[i + 1]! + 0.114 * frame2[i + 2]!;
    const diff = lum1 - lum2;
    sum += diff;
    sumSq += diff * diff;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
