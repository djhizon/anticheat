const builtIn = /(?:macbook.*microphone|built[ -]?in.*(?:microphone|mic)|internal microphone)/i;
const excluded = /virtual|blackhole|loopback|obs|iphone|airpods|headset|usb|aggregate/i;

/** Labels guide device selection; they are not hardware attestation. */
export function selectBuiltInMicrophone(devices: readonly MediaDeviceInfo[]) {
  return devices.find(
    (device) =>
      device.kind === 'audioinput' &&
      !['default', 'communications', ''].includes(device.deviceId) &&
      builtIn.test(device.label) &&
      !excluded.test(device.label),
  );
}

export async function acquireBuiltInMicrophone(
  media = navigator.mediaDevices,
): Promise<MediaStream> {
  const selected = selectBuiltInMicrophone(await media.enumerateDevices());
  if (!selected)
    throw new Error(
      'Built-in laptop microphone unavailable. Allow microphone access in macOS Privacy settings, reopen the app, and retry. No external/default microphone will be used.',
    );
  const stream = await media.getUserMedia({
    video: false,
    audio: {
      deviceId: { exact: selected.deviceId },
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const track = stream.getAudioTracks()[0];
  if (
    !track ||
    !builtIn.test(track.label) ||
    excluded.test(track.label) ||
    track.getSettings().deviceId !== selected.deviceId ||
    track.readyState === 'ended'
  ) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      'The built-in microphone selection could not be verified. Audio stopped; no fallback device was used.',
    );
  }
  return stream;
}
