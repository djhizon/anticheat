import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Camera hardware attestation (Mac app only).
 *
 * The browser sees only camera labels, so a virtual camera (OBS, Camo, any Camera Extension) can
 * pass a label check by copying a harmless name. The native helper's `camera-list` action reports
 * each macOS video device with its CoreMediaIO transport type and providing plug-in, already
 * classified. Here the renderer's label is matched to that list and turned into a verdict.
 * Enumeration only: no camera stream is opened by the helper.
 */

export type CameraKind = 'builtin' | 'usb' | 'continuity' | 'virtual' | 'unknown';
export type AttestationVerdict = 'hardware' | 'virtual' | 'unknown';

export interface NativeCamera {
  name: string;
  uniqueID: string;
  modelID: string;
  manufacturer: string;
  deviceType: string;
  transportType: string;
  isConnected: boolean;
  plugInBundleId: string | null;
  kind: CameraKind;
  reasons: string[];
}

export interface MatchedCamera {
  name: string;
  kind: CameraKind;
  transportType: string;
  modelID: string;
  manufacturer: string;
}

export interface CameraAttestation {
  verdict: AttestationVerdict;
  kind: CameraKind;
  reasons: string[];
  matchedDevice: MatchedCamera | null;
}

const KINDS: readonly CameraKind[] = ['builtin', 'usb', 'continuity', 'virtual', 'unknown'];
const HARDWARE: ReadonlySet<CameraKind> = new Set(['builtin', 'usb', 'continuity']);
export const ATTESTATION_CACHE_MS = 10_000;
const MAX_LABEL = 256;

const shortString = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length <= max;

/** Strict parse of the helper reply; null when anything is missing or malformed. */
export function parseCameraList(reply: unknown): NativeCamera[] | null {
  if (!reply || typeof reply !== 'object' || !('cameras' in reply)) return null;
  const list = (reply as { cameras: unknown }).cameras;
  if (!Array.isArray(list) || list.length > 64) return null;
  const cameras: NativeCamera[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const plugIn = c.plugInBundleId ?? null;
    if (
      !shortString(c.name) ||
      !c.name.trim() ||
      ![c.uniqueID, c.modelID, c.manufacturer, c.deviceType, c.transportType].every((v) =>
        shortString(v),
      ) ||
      typeof c.isConnected !== 'boolean' ||
      (plugIn !== null && !shortString(plugIn)) ||
      !KINDS.includes(c.kind as CameraKind) ||
      !Array.isArray(c.reasons) ||
      !c.reasons.every((r) => shortString(r))
    )
      return null;
    cameras.push({
      name: c.name,
      uniqueID: c.uniqueID as string,
      modelID: c.modelID as string,
      manufacturer: c.manufacturer as string,
      deviceType: c.deviceType as string,
      transportType: c.transportType as string,
      isConnected: c.isConnected,
      plugInBundleId: plugIn as string | null,
      kind: c.kind as CameraKind,
      reasons: c.reasons as string[],
    });
  }
  return cameras;
}

const normalize = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Chromium appends " (vvvv:pppp)" (USB vendor:product, hex) to labels of UVC cameras on macOS. */
export function parseBrowserLabel(label: string): { base: string; usbId: string | null } {
  const match = /^(.*\S)\s*\(([0-9a-f]{4}):([0-9a-f]{4})\)\s*$/i.exec(label);
  if (!match) return { base: label, usbId: null };
  return { base: match[1]!, usbId: `${match[2]}:${match[3]}`.toLowerCase() };
}

/** "vvvv:pppp" from the macOS modelID ("UVC Camera VendorID_1452 ProductID_34068") or uniqueID. */
export function nativeUsbId(camera: Pick<NativeCamera, 'modelID' | 'uniqueID'>): string | null {
  const hex = (value: string) => Number(value).toString(16).padStart(4, '0');
  const model = /VendorID_(\d{1,5})\s+ProductID_(\d{1,5})/.exec(camera.modelID);
  if (model && Number(model[1]) <= 0xffff && Number(model[2]) <= 0xffff)
    return `${hex(model[1]!)}:${hex(model[2]!)}`;
  const unique = /^0x[0-9a-f]{8}([0-9a-f]{4})([0-9a-f]{4})$/i.exec(camera.uniqueID);
  return unique ? `${unique[1]}:${unique[2]}`.toLowerCase() : null;
}

const describe = (c: NativeCamera): MatchedCamera => ({
  name: c.name,
  kind: c.kind,
  transportType: c.transportType,
  modelID: c.modelID,
  manufacturer: c.manufacturer,
});

/** Matches a browser camera label to the helper's device list and merges the verdict. */
export function attestLabel(
  label: string,
  cameras: readonly NativeCamera[] | null,
): CameraAttestation {
  const unknown = (reasons: string[], matched: NativeCamera | null = null): CameraAttestation => ({
    verdict: 'unknown',
    kind: matched?.kind ?? 'unknown',
    reasons,
    matchedDevice: matched ? describe(matched) : null,
  });
  if (!cameras) return unknown(['The macOS camera check is unavailable.']);
  const { base, usbId } = parseBrowserLabel(label);
  const reasons: string[] = [];
  // A device literally named like the whole label (suffix included) always counts: a virtual
  // camera can copy "FaceTime HD Camera (Built-in) (05ac:8514)" as its name.
  const exact = cameras.filter((c) => normalize(c.name) === normalize(label));
  let byBase = usbId ? cameras.filter((c) => normalize(c.name) === normalize(base)) : [];
  let downgrade = false;
  if (usbId && byBase.length > 0) {
    const consistent = byBase.filter((c) => nativeUsbId(c) === usbId);
    const mismatched = byBase.filter((c) => {
      const id = nativeUsbId(c);
      return id !== null && id !== usbId;
    });
    if (consistent.length > 0) byBase = consistent;
    else if (mismatched.length > 0 && mismatched.length === byBase.length) {
      const ids = [...new Set(mismatched.map((c) => nativeUsbId(c)))].join(', ');
      return {
        verdict: 'virtual',
        kind: 'virtual',
        reasons: [
          `The browser reports USB id ${usbId} but the macOS camera "${mismatched[0]!.name}" is ${ids}: the label does not belong to that camera.`,
        ],
        matchedDevice: describe(mismatched[0]!),
      };
    } else {
      byBase = byBase.filter((c) => nativeUsbId(c) === null);
      downgrade = true;
      reasons.push(
        `The browser reports USB id ${usbId}, which macOS does not report for this camera.`,
      );
    }
  }
  const candidates = [...new Set([...exact, ...byBase])];
  if (candidates.length === 0)
    return unknown([`No macOS camera named "${base}" was found by the native check.`]);
  const virtual = candidates.find((c) => c.kind === 'virtual');
  if (virtual) {
    const imitation = candidates.some((c) => c.kind !== 'virtual');
    return {
      verdict: 'virtual',
      kind: 'virtual',
      reasons: [
        ...(imitation
          ? [`A virtual camera uses the same name as a real camera ("${virtual.name}").`]
          : []),
        ...virtual.reasons,
      ],
      matchedDevice: describe(virtual),
    };
  }
  const first = candidates[0]!;
  if (!candidates.every((c) => HARDWARE.has(c.kind)) || downgrade) {
    const odd = candidates.find((c) => !HARDWARE.has(c.kind)) ?? first;
    return unknown([...reasons, ...odd.reasons], odd);
  }
  return {
    verdict: 'hardware',
    kind: first.kind,
    reasons: [...first.reasons],
    matchedDevice: describe(first),
  };
}

export type CameraListCall = () => Promise<unknown>;

/** Native helper client: fixed executable, JSON on stdin, JSON reply. Never a shell. */
export function createCameraListCall(executable: string): CameraListCall {
  return () =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [],
        { timeout: 6000, maxBuffer: 256 * 1024 },
        (error, stdout) => {
          if (error) return reject(new Error('Native camera check unavailable.'));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid native camera response.'));
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(
        JSON.stringify({
          action: 'camera-list',
          hostPid: process.pid,
          hostExecutable: process.execPath,
        }),
      );
    });
}

/**
 * The device list is cached for 10 s and concurrent requests share one helper run. A refresh (the
 * renderer saw a devicechange) or a label missing from the cached list re-runs the helper, at most
 * once per second, so a camera added since the last run is never judged from a stale list.
 */
export const ATTESTATION_REFRESH_MIN_MS = 1000;
export function createCameraAttestor(options: { call: CameraListCall; now?: () => number }) {
  const now = options.now ?? Date.now;
  let cached: { at: number; cameras: NativeCamera[] } | null = null;
  let inFlight: Promise<NativeCamera[] | null> | null = null;
  const fetchList = (): Promise<NativeCamera[] | null> => {
    if (inFlight) return inFlight;
    inFlight = options
      .call()
      .then((reply) => {
        const cameras = parseCameraList(reply);
        // Failures are not cached: the next request retries the helper.
        if (cameras) cached = { at: now(), cameras };
        return cameras;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const list = (refresh: boolean): Promise<NativeCamera[] | null> => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < ATTESTATION_CACHE_MS && (!refresh || age < ATTESTATION_REFRESH_MIN_MS))
      return Promise.resolve(cached.cameras);
    return fetchList();
  };
  return {
    async attest(
      label: string,
      attestOptions: { refresh?: boolean } = {},
    ): Promise<CameraAttestation> {
      const cameras = await list(attestOptions.refresh === true);
      const result = attestLabel(label, cameras);
      if (cameras && result.matchedDevice === null && result.verdict === 'unknown')
        return attestLabel(label, await list(true));
      return result;
    },
  };
}

interface FrameEvent {
  sender: unknown;
  senderFrame?: { url: string } | null;
}

export interface CameraAttestationOptions {
  ipcMain: {
    handle(channel: string, handler: (event: never, ...args: unknown[]) => unknown): void;
  };
  isPackaged: boolean;
  resourcesPath: string;
  appDir: string;
  trustedAppFrame: (event: FrameEvent) => boolean;
  /** Injectable for tests; defaults to the bundled app-control helper. */
  call?: CameraListCall;
  now?: () => number;
}

export const CAMERA_ATTESTATION_CHANNEL = 'camera-attestation';

/** Wires the narrow `camera-attestation` IPC (trusted app frame only, one label string). */
export function registerCameraAttestation(options: CameraAttestationOptions) {
  const executable = options.isPackaged
    ? path.join(options.resourcesPath, 'app-control')
    : path.join(options.appDir, '../native-bin/app-control');
  const attestor = createCameraAttestor({
    call: options.call ?? createCameraListCall(executable),
    ...(options.now ? { now: options.now } : {}),
  });
  options.ipcMain.handle(
    CAMERA_ATTESTATION_CHANNEL,
    (event: never, label: unknown, request: unknown) => {
      if (!options.trustedAppFrame(event as FrameEvent))
        throw new Error('Untrusted application request.');
      if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL)
        throw new Error('Invalid camera label.');
      if (
        request !== undefined &&
        (!request ||
          typeof request !== 'object' ||
          Object.keys(request).join(',') !== 'refresh' ||
          typeof (request as { refresh: unknown }).refresh !== 'boolean')
      )
        throw new Error('Invalid camera request.');
      return attestor.attest(label, {
        refresh: (request as { refresh?: boolean })?.refresh === true,
      });
    },
  );
  return attestor;
}
