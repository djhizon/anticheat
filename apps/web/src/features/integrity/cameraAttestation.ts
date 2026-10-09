/**
 * Camera hardware attestation, available only in the ExamGuard Mac app.
 *
 * A browser can only see camera labels, so a virtual camera with a harmless-looking name passes
 * the label heuristics. The Mac app asks macOS which driver and transport each camera uses and
 * answers hardware | virtual | unknown for a label. In a plain browser the bridge is absent and
 * nothing here changes behaviour.
 */

export type AttestedKind = 'builtin' | 'usb' | 'continuity' | 'virtual' | 'unknown';

export interface CameraAttestation {
  readonly verdict: 'hardware' | 'virtual' | 'unknown';
  readonly kind: AttestedKind;
  readonly reasons: readonly string[];
  readonly matchedDevice: { readonly name: string; readonly kind: AttestedKind } | null;
}

/** Attests one browser camera label (Mac app only). */
export type AttestCamera = (label: string) => Promise<CameraAttestation>;

type RawBridge = (label: string, options?: { refresh: boolean }) => Promise<unknown>;

const VERDICTS = new Set(['hardware', 'virtual', 'unknown']);
const KINDS = new Set<AttestedKind>(['builtin', 'usb', 'continuity', 'virtual', 'unknown']);
export const ATTESTATION_TIMEOUT_MS = 8000;

const UNKNOWN = (reason: string): CameraAttestation => ({
  verdict: 'unknown',
  kind: 'unknown',
  reasons: [reason],
  matchedDevice: null,
});

/** Validates the bridge reply; anything malformed becomes `unknown` (never a lock-out). */
export function toAttestation(value: unknown): CameraAttestation {
  if (!value || typeof value !== 'object') return UNKNOWN('The Mac camera check gave no answer.');
  const v = value as Record<string, unknown>;
  const matched = v.matchedDevice as Record<string, unknown> | null | undefined;
  if (
    !VERDICTS.has(v.verdict as string) ||
    !KINDS.has(v.kind as AttestedKind) ||
    !Array.isArray(v.reasons) ||
    !v.reasons.every((r) => typeof r === 'string')
  )
    return UNKNOWN('The Mac camera check gave an invalid answer.');
  const device =
    matched && typeof matched.name === 'string' && KINDS.has(matched.kind as AttestedKind)
      ? { name: matched.name, kind: matched.kind as AttestedKind }
      : null;
  return {
    verdict: v.verdict as CameraAttestation['verdict'],
    kind: v.kind as AttestedKind,
    reasons: v.reasons as string[],
    matchedDevice: device,
  };
}

// Devices changed since the last attestation: the next call asks the Mac app for a fresh list.
let devicesChanged = false;
let listening: MediaDevices | null = null;
function trackDeviceChanges(): void {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!media?.addEventListener || listening === media) return;
  listening = media;
  media.addEventListener('devicechange', () => {
    devicesChanged = true;
  });
}

/**
 * The Mac app's attestation, wrapped with validation and a timeout; null in a plain browser.
 * Errors and timeouts resolve to `unknown`.
 */
export function cameraAttestation(
  bridgeSource: unknown = typeof window === 'undefined' ? undefined : window,
): AttestCamera | null {
  const bridge = (bridgeSource as { electronExam?: { getCameraAttestation?: unknown } } | undefined)
    ?.electronExam?.getCameraAttestation;
  if (typeof bridge !== 'function') return null;
  trackDeviceChanges();
  return async (label) => {
    const refresh = devicesChanged;
    devicesChanged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        (bridge as RawBridge)(label, { refresh }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ATTESTATION_TIMEOUT_MS);
        }),
      ]);
      return toAttestation(reply);
    } catch {
      return UNKNOWN('The Mac camera check did not answer.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

const KIND_TEXT: Partial<Record<AttestedKind, string>> = {
  builtin: 'built-in',
  usb: 'USB',
  continuity: 'iPhone Continuity Camera',
};

/** "Verified hardware camera: FaceTime HD Camera (built-in)" for hardware verdicts, else null. */
export function hardwareCameraText(attestation: CameraAttestation | undefined): string | null {
  if (attestation?.verdict !== 'hardware') return null;
  const name = attestation.matchedDevice?.name ?? 'camera';
  const kind = KIND_TEXT[attestation.kind];
  return `Verified hardware camera: ${name}${kind ? ` (${kind})` : ''}`;
}
