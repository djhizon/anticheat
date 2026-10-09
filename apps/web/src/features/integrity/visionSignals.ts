export interface HeadPose {
  readonly yaw: number;
  readonly pitch: number;
}
export interface VisionObservation {
  readonly faces: number;
  readonly pose: HeadPose | null;
  readonly phone: boolean;
  readonly earbuds: boolean | null;
  readonly smartGlasses: boolean | null;
  readonly phoneAvailable?: boolean;
  /** 0–1: average of left+right eye blink blendshapes. >0.4 = blink. */
  readonly blinkScore: number;
  /** Face landmark jitter — standard deviation of x across recent frames. >0.002 = live. */
  readonly landmarkJitter: number;
}
export type VisionReply =
  { type: 'ready' } | { type: 'observation'; observation: VisionObservation } | { type: 'error' };

/** MediaPipe's transform is column-major. Normalize away scale before Euler extraction. */
export function poseFromMatrix(data: readonly number[]): HeadPose | null {
  if (data.length !== 16 || data.some((value) => !Number.isFinite(value))) return null;
  const [x, y, z] = [data[8]!, data[9]!, data[10]!];
  const scale = Math.hypot(x, y, z);
  if (scale < 0.00001) return null;
  return {
    yaw: (Math.atan2(x, z) * 180) / Math.PI,
    pitch: (Math.atan2(-y, Math.hypot(x, z)) * 180) / Math.PI,
  };
}

function angleDelta(current: number, baseline: number): number {
  return ((((current - baseline) % 360) + 540) % 360) - 180;
}

export function relativePose(current: HeadPose, baseline: HeadPose): HeadPose {
  return {
    yaw: Math.round(angleDelta(current.yaw, baseline.yaw)),
    pitch: Math.round(angleDelta(current.pitch, baseline.pitch)),
  };
}

/** A second nearby positive sample filters single-frame object-detector flicker. */
export function createPhoneConfirmation() {
  let previous: number | null = null;
  return {
    sample(detected: boolean, now: number): boolean {
      const confirmed = detected && previous !== null && now > previous && now - previous <= 1500;
      previous = detected ? now : null;
      return confirmed;
    },
    clear(): void {
      previous = null;
    },
  };
}
