/**
 * Hands the camera and microphone streams that the pre-exam setup already verified over to the
 * exam page, so the exam never prompts again. Streams are module-level (never persisted); after
 * a page refresh the hub is empty and the exam page re-acquires them instead.
 */
let camera: MediaStream | null = null;
let microphone: MediaStream | null = null;

function isLive(stream: MediaStream | null): stream is MediaStream {
  if (stream === null) return false;
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.every((track) => track.readyState === 'live');
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Takes ownership of the streams; any previously held streams are stopped. */
export function holdSensorStreams(streams: {
  readonly camera?: MediaStream | null;
  readonly microphone?: MediaStream | null;
}): void {
  if (camera !== (streams.camera ?? null)) stopStream(camera);
  if (microphone !== (streams.microphone ?? null)) stopStream(microphone);
  camera = streams.camera ?? null;
  microphone = streams.microphone ?? null;
}

/** The held camera stream when every track is still live, otherwise null. */
export function heldCameraStream(): MediaStream | null {
  return isLive(camera) ? camera : null;
}

export function heldMicrophoneStream(): MediaStream | null {
  return isLive(microphone) ? microphone : null;
}

export function hasHeldSensors(): boolean {
  return heldCameraStream() !== null && heldMicrophoneStream() !== null;
}

export function releaseSensorStreams(): void {
  stopStream(camera);
  stopStream(microphone);
  camera = null;
  microphone = null;
}
