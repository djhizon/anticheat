import { VIRTUAL_CAMERA_LABEL as virtualLabel } from '@examguard/contracts/exam';

// The native camera the student chose in the camera gate (kept for the exam's own streams).
let preferredCameraId: string | null = null;

export function setPreferredCameraId(deviceId: string | null): void {
  preferredCameraId = deviceId;
}

const BUILT_IN_LABEL = /facetime|built.?in|integrated/i;

export interface CameraChoices {
  /** Allowed hardware cameras, best first (built-in, then other native cameras). */
  readonly native: readonly MediaDeviceInfo[];
  /** Virtual / software cameras: listed to the student but never usable. */
  readonly virtual: readonly MediaDeviceInfo[];
}

/**
 * Policy: only non-virtual cameras may run an exam. The built-in webcam is
 * preferred. Other native cameras (USB webcams and iPhone Continuity Camera,
 * which presents as a hardware camera) are allowed but ranked after it, so
 * they are used only when selected explicitly or when no built-in exists.
 */
export function classifyCameras(devices: readonly MediaDeviceInfo[]): CameraChoices {
  const cameras = devices.filter((d) => d.kind === 'videoinput' && d.label.trim());
  const native = cameras.filter((d) => !virtualLabel.test(d.label));
  return {
    native: [
      ...native.filter((d) => BUILT_IN_LABEL.test(d.label)),
      ...native.filter((d) => !BUILT_IN_LABEL.test(d.label)),
    ],
    virtual: cameras.filter((d) => virtualLabel.test(d.label)),
  };
}

export function selectCamera(
  devices: readonly MediaDeviceInfo[],
  preferredId?: string,
): MediaDeviceInfo | undefined {
  const { native } = classifyCameras(devices);
  return native.find((d) => preferredId !== undefined && d.deviceId === preferredId) ?? native[0];
}

/** Device labels are a selection heuristic, not proof of an unmodified sensor feed. */
export async function acquirePhysicalCamera(
  media: MediaDevices = navigator.mediaDevices,
  preferredId?: string,
): Promise<MediaStream> {
  let devices = await media.enumerateDevices();
  if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
    const permission = await media.getUserMedia({ video: true, audio: false });
    permission.getTracks().forEach((track) => track.stop());
    devices = await media.enumerateDevices();
  }
  const selected = selectCamera(devices, preferredId ?? preferredCameraId ?? undefined);
  if (!selected)
    throw new Error(
      'No labelled non-virtual camera is available. Enable the built-in webcam and retry.',
    );
  const stream = await media.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: selected.deviceId },
      width: { ideal: 640, max: 640 },
      height: { ideal: 480, max: 480 },
      frameRate: { ideal: 15, max: 15 },
    },
  });
  const track = stream.getVideoTracks()[0];
  if (
    !track ||
    virtualLabel.test(track.label) ||
    track.getSettings().deviceId !== selected.deviceId
  ) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      'The selected camera could not be verified. OBS/virtual-camera fallback is disabled.',
    );
  }
  return stream;
}

// The exam's long-lived camera-panel stream, watched by the mid-exam camera
// guard. Short-lived streams (e.g. liveness captures) are deliberately not
// registered, so closing them is never mistaken for an unplugged camera.
let activeTrack: MediaStreamTrack | null = null;

export function setActiveCameraStream(stream: MediaStream | null): void {
  activeTrack = stream?.getVideoTracks()[0] ?? null;
}

export function activeCameraTrack(): MediaStreamTrack | null {
  return activeTrack;
}
