export interface DesktopAppTarget {
  id: string;
  name: string;
  protected: boolean;
  exempt: boolean;
  reason: string;
  canForce: boolean;
}
export type DesktopRunMode = 'demo' | 'strict';
export interface DesktopDemoInfo {
  /** Names of the apps the native helper really exempts in demo mode. */
  exemptApps: string[];
  /** True for an installed app; false for a development run from source. */
  packaged: boolean;
}
export interface DesktopAppsBridge {
  getRunMode?(): Promise<unknown>;
  getDemoInfo?(): Promise<unknown>;
  /** Opens the on-demand LAN listener for iPhone pairing and returns its origin. */
  startPhoneLan?(): Promise<unknown>;
  /** Native check of the selected camera (by label); may be absent in older builds. */
  getCameraAttestation?(label: string): Promise<unknown>;
  getDisplayCount(): Promise<number>;
  getEnvironmentRisk?(): Promise<{ virtualMachine: string | null; captureDisplays: string[] }>;
  listAppTargets(): Promise<unknown>;
  closeAppTarget(id: string, mode: 'quit' | 'force'): Promise<{ status: string; message: string }>;
}
export function desktopAppsBridge(): DesktopAppsBridge | undefined {
  return (window as Window & { electronExam?: DesktopAppsBridge }).electronExam;
}
export function parseAppTargets(value: unknown): DesktopAppTarget[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (a) =>
        a &&
        typeof a === 'object' &&
        typeof a.id === 'string' &&
        a.id.length > 0 &&
        typeof a.name === 'string' &&
        typeof a.reason === 'string' &&
        typeof a.protected === 'boolean' &&
        typeof a.exempt === 'boolean' &&
        typeof a.canForce === 'boolean',
    ) ||
    new Set(value.map((a) => a.id)).size !== value.length
  ) {
    throw new Error('Invalid desktop inventory.');
  }
  return value;
}
/** Unknown or unavailable mode is treated as strict: the safe, existing behaviour. */
export async function readDesktopRunMode(
  bridge: DesktopAppsBridge | undefined = desktopAppsBridge(),
): Promise<DesktopRunMode> {
  try {
    if (typeof bridge?.getRunMode !== 'function') return 'strict';
    return (await bridge.getRunMode()) === 'demo' ? 'demo' : 'strict';
  } catch {
    return 'strict';
  }
}

/** Validated demo notice data; null when unavailable (the notice then makes no specific claims). */
export async function readDemoInfo(
  bridge: DesktopAppsBridge | undefined = desktopAppsBridge(),
): Promise<DesktopDemoInfo | null> {
  try {
    if (typeof bridge?.getDemoInfo !== 'function') return null;
    const value = (await bridge.getDemoInfo()) as Partial<DesktopDemoInfo> | null;
    if (!value || !Array.isArray(value.exemptApps) || typeof value.packaged !== 'boolean')
      return null;
    return {
      exemptApps: value.exemptApps.filter((n): n is string => typeof n === 'string' && n !== ''),
      packaged: value.packaged,
    };
  } catch {
    return null;
  }
}

/** Joins names as "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The demo strip text, built from the real exemption list; the terminal sentence is dev-only. */
export function demoExemptionText(info: DesktopDemoInfo | null): string {
  const apps =
    info === null
      ? 'Some development apps may be exempt from the app check.'
      : info.exemptApps.length > 0
        ? `${listNames(info.exemptApps)} ${info.exemptApps.length === 1 ? 'is' : 'are'} exempt from the app check.`
        : 'No apps are exempt from the app check.';
  const tail = info?.packaged === false ? ' Keep the local server terminal running.' : '';
  return `Demo mode: ${apps} Strict mode has no exemptions.${tail}`;
}

export type CameraAttestation = 'virtual' | 'ok' | 'unknown';

/** Reads the desktop camera attestation; absent bridge or unreadable answers are 'unknown'. */
export async function readCameraAttestation(
  label: string,
  bridge: DesktopAppsBridge | undefined = desktopAppsBridge(),
): Promise<CameraAttestation> {
  if (typeof bridge?.getCameraAttestation !== 'function') return 'unknown';
  try {
    const value = (await bridge.getCameraAttestation(label)) as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return 'unknown';
    // The Mac app answers { verdict: 'hardware' | 'virtual' | 'unknown', … }.
    if (
      value.verdict === 'virtual' ||
      value.virtual === true ||
      value.isVirtual === true ||
      value.kind === 'virtual' ||
      value.status === 'virtual'
    )
      return 'virtual';
    if (
      value.verdict === 'hardware' ||
      value.virtual === false ||
      value.isVirtual === false ||
      value.kind === 'native' ||
      value.kind === 'physical' ||
      value.status === 'ok'
    )
      return 'ok';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
