import type { ExamApi } from '../exam/api.js';

export type ProfileName = 'high' | 'standard' | 'low';
export type ProfileChoice = ProfileName | 'local-only';

export interface RecordingProfile {
  readonly name: ProfileName;
  /** Plain-language label shown in the student status line. */
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly videoBitsPerSecond: number;
  /** Minimum measured upload (kbps) at which this profile is chosen. */
  readonly minUploadKbps: number;
}

/**
 * Each profile's bitrate stays at or below ~25% of the upload speed that selects it
 * (1500/6000, 600/2500), leaving headroom for exam saves and heartbeats. The lowest
 * profile is the floor: slower links rely on step-down/local fallback in the recorder.
 */
export const PROFILES: Readonly<Record<ProfileName, RecordingProfile>> = {
  high: {
    name: 'high',
    label: '720p (fast network)',
    width: 1280,
    height: 720,
    frameRate: 15,
    videoBitsPerSecond: 1_500_000,
    minUploadKbps: 6000,
  },
  standard: {
    name: 'standard',
    label: '540p (good network)',
    width: 960,
    height: 540,
    frameRate: 8,
    videoBitsPerSecond: 600_000,
    minUploadKbps: 2500,
  },
  low: {
    name: 'low',
    label: '360p (slow network)',
    width: 640,
    height: 360,
    frameRate: 5,
    videoBitsPerSecond: 250_000,
    minUploadKbps: 0,
  },
};

/** Today's behaviour: saved on the student's computer, no upload. */
export const LOCAL_PROFILE = {
  width: 1280,
  height: 720,
  frameRate: 5,
  videoBitsPerSecond: 250_000,
} as const;

const ORDER: readonly ProfileName[] = ['low', 'standard', 'high'];

export function chooseProfile(uploadKbps: number | null | undefined): ProfileChoice {
  if (uploadKbps === null || uploadKbps === undefined || !Number.isFinite(uploadKbps)) {
    return 'local-only';
  }
  if (uploadKbps <= 0) return 'local-only';
  if (uploadKbps >= PROFILES.high.minUploadKbps) return 'high';
  if (uploadKbps >= PROFILES.standard.minUploadKbps) return 'standard';
  return 'low';
}

export function stepDown(name: ProfileName): ProfileName {
  return ORDER[Math.max(0, ORDER.indexOf(name) - 1)]!;
}

export function stepUp(name: ProfileName): ProfileName {
  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(name) + 1)]!;
}

export function profileRank(name: ProfileName): number {
  return ORDER.indexOf(name);
}

export interface ConnectionHint {
  readonly effectiveType?: string;
  readonly downlink?: number;
}

export function readConnectionHint(): ConnectionHint | null {
  const connection = (navigator as unknown as { connection?: ConnectionHint }).connection;
  if (!connection) return null;
  return {
    ...(connection.effectiveType === undefined ? {} : { effectiveType: connection.effectiveType }),
    ...(connection.downlink === undefined ? {} : { downlink: connection.downlink }),
  };
}

/** The browser hint can only make the choice more conservative, never faster. */
export function applyConnectionHint(
  choice: ProfileChoice,
  hint: ConnectionHint | null,
): ProfileChoice {
  if (choice === 'local-only' || !hint) return choice;
  if (hint.effectiveType && ['slow-2g', '2g', '3g'].includes(hint.effectiveType)) return 'low';
  return choice;
}

function randomBase64(chars: number): string {
  const bytes = new Uint8Array(Math.floor((chars * 3) / 4));
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)));
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export interface ProbeOptions {
  readonly sampleChars?: readonly number[];
  readonly now?: () => number;
}

/**
 * Measures upload throughput (kbps) by timing POSTs of random data to /exam/speedtest.
 * Returns the faster sample, or null when offline or every sample failed.
 */
export async function probeUploadKbps(
  api: Pick<ExamApi, 'speedtest'>,
  options: ProbeOptions = {},
): Promise<number | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const now = options.now ?? (() => performance.now());
  let best: number | null = null;
  for (const chars of options.sampleChars ?? [256 * 1024, 1024 * 1024]) {
    try {
      const payload = randomBase64(chars);
      const started = now();
      await api.speedtest(payload);
      const seconds = Math.max(0.001, (now() - started) / 1000);
      const kbps = (payload.length * 8) / 1000 / seconds;
      if (best === null || kbps > best) best = kbps;
    } catch {
      // A failed sample just contributes nothing; null overall means local-only.
    }
  }
  return best;
}
