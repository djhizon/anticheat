const virtualLabel = /obs|virtual|camtwist|snap camera|manycam|epoccam|ndi video/i;
export function selectCamera(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const candidates = devices.filter(
    (d) => d.kind === 'videoinput' && d.label.trim() && !virtualLabel.test(d.label),
  );
  return candidates.find((d) => /facetime|built.?in|integrated/i.test(d.label)) ?? candidates[0];
}

/** Device labels are a selection heuristic, not proof of an unmodified sensor feed. */
export async function acquirePhysicalCamera(
  media: MediaDevices = navigator.mediaDevices,
): Promise<MediaStream> {
  let devices = await media.enumerateDevices();
  if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
    const permission = await media.getUserMedia({ video: true, audio: false });
    permission.getTracks().forEach((track) => track.stop());
    devices = await media.enumerateDevices();
  }
  const selected = selectCamera(devices);
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
