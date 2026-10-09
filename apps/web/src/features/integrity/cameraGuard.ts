import { VIRTUAL_CAMERA_LABEL } from '@exam-anti-cheat/contracts/exam';

const CAPTURE_DEVICE_LABEL = /elgato|avermedia|cam link|capture|blackmagic|magewell|hdmi/i;

export interface CameraGuardOptions {
  readonly media: MediaDevices;
  readonly report: (event: string) => void;
  readonly getActiveTrack?: () => MediaStreamTrack | null;
}

/**
 * Watches for mid-exam webcam swaps: the active track ending, its device
 * disappearing, virtual cameras appearing, or video-capture hardware being
 * attached. Event-driven only (no polling). Returns a cleanup function.
 */
export function startCameraGuard(options: CameraGuardOptions): () => void {
  const { media, report, getActiveTrack } = options;
  const reported = new Set<string>();
  let stopped = false;

  const emit = (event: string, key: string = event): void => {
    if (stopped || reported.has(key)) return;
    reported.add(key);
    report(event);
  };

  const onTrackEnded = (): void => emit('camera_disconnected');
  let watchedTrack: MediaStreamTrack | null = null;
  const watchTrack = (): MediaStreamTrack | null => {
    const track = getActiveTrack?.() ?? null;
    if (track && track !== watchedTrack) {
      watchedTrack?.removeEventListener('ended', onTrackEnded);
      watchedTrack = track;
      track.addEventListener('ended', onTrackEnded);
      if (track.readyState === 'ended') onTrackEnded();
    }
    return track;
  };

  const onDeviceChange = (): void => {
    void media
      .enumerateDevices()
      .then((devices) => {
        if (stopped) return;
        const cameras = devices.filter((d) => d.kind === 'videoinput');
        for (const cam of cameras) {
          if (VIRTUAL_CAMERA_LABEL.test(cam.label))
            emit('virtual_camera_connected', `virtual:${cam.label}`);
          if (CAPTURE_DEVICE_LABEL.test(cam.label))
            emit('capture_device_connected', `capture:${cam.label}`);
        }
        const track = watchTrack();
        if (!track) return;
        if (VIRTUAL_CAMERA_LABEL.test(track.label)) emit('camera_swapped_to_virtual');
        const deviceId = track.getSettings().deviceId;
        if (deviceId && !cameras.some((c) => c.deviceId === deviceId)) emit('camera_disconnected');
      })
      .catch(() => {});
  };

  watchTrack();
  media.addEventListener('devicechange', onDeviceChange);
  return () => {
    stopped = true;
    media.removeEventListener('devicechange', onDeviceChange);
    watchedTrack?.removeEventListener('ended', onTrackEnded);
    watchedTrack = null;
  };
}
