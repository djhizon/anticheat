/**
 * Best-effort camera tuning through the standard track capabilities (exposure, white balance,
 * brightness). Chrome on macOS exposes very few of these, so every step is optional and a failure
 * is ignored: the picture simply stays as it is.
 */

interface RangeCapability {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

type TuneKey = 'exposureMode' | 'exposureCompensation' | 'whiteBalanceMode' | 'brightness';

export interface CameraTuningResult {
  /** Names of the settings that were applied. Empty when the camera exposes none. */
  readonly applied: readonly string[];
  readonly supported: boolean;
}

const NOT_SUPPORTED: CameraTuningResult = { applied: [], supported: false };

function isRange(value: unknown): value is RangeCapability {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as RangeCapability).min) &&
    Number.isFinite((value as RangeCapability).max)
  );
}

/** A value `fraction` of the way up the range, snapped to the step. */
function pick(range: RangeCapability, fraction: number): number {
  const raw = range.min + (range.max - range.min) * fraction;
  const step = range.step && range.step > 0 ? range.step : 0;
  const snapped = step ? range.min + Math.round((raw - range.min) / step) * step : raw;
  return Math.min(range.max, Math.max(range.min, snapped));
}

/**
 * Ask the camera for continuous auto exposure / white balance and a brighter picture.
 * `dim` pushes exposure compensation and brightness higher. Never throws.
 */
export async function tuneCameraTrack(
  track: MediaStreamTrack | undefined,
  options: { readonly dim?: boolean } = {},
): Promise<CameraTuningResult> {
  if (!track || typeof track.getCapabilities !== 'function') return NOT_SUPPORTED;
  let capabilities: Record<string, unknown>;
  try {
    capabilities = track.getCapabilities() as unknown as Record<string, unknown>;
  } catch {
    return NOT_SUPPORTED;
  }
  const wanted: Partial<Record<TuneKey, unknown>> = {};
  const modes = (key: TuneKey): readonly string[] =>
    Array.isArray(capabilities[key]) ? (capabilities[key] as string[]) : [];
  if (modes('exposureMode').includes('continuous')) wanted.exposureMode = 'continuous';
  if (modes('whiteBalanceMode').includes('continuous')) wanted.whiteBalanceMode = 'continuous';
  const compensation = capabilities.exposureCompensation;
  if (isRange(compensation) && options.dim) wanted.exposureCompensation = pick(compensation, 0.8);
  const brightness = capabilities.brightness;
  if (isRange(brightness) && options.dim) wanted.brightness = pick(brightness, 0.65);

  const applied: string[] = [];
  // Apply one at a time so a single rejected constraint does not discard the others.
  for (const [name, value] of Object.entries(wanted)) {
    try {
      await track.applyConstraints({
        advanced: [{ [name]: value } as MediaTrackConstraintSet],
      });
      applied.push(name);
    } catch {
      /* Unsupported or refused by the driver: ignore. */
    }
  }
  return { applied, supported: applied.length > 0 };
}
