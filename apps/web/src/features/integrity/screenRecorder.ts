import type { ExamApi } from '../exam/api.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';

/** Local-only segments: no speed test, base64 encoding, or recording API calls. */
export function createScreenRecorder(
  _attemptId: string,
  _examApi?: ExamApi,
  status: (message: string) => void = () => {},
) {
  let stopped = false;
  let started = false;
  let screen: MediaStream | null = null;
  let microphone: MediaStream | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let segment = 0;
  const session = new Date().toISOString().replace(/[:.]/g, '-');
  function release() {
    screen?.getTracks().forEach((track) => track.stop());
    microphone?.getTracks().forEach((track) => track.stop());
  }
  function download(blob: Blob) {
    if (!blob.size) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exam-demo-${session}-${++segment}.webm`;
    document.body.append(link);
    link.click();
    link.remove();
    // Allow the download handler to acquire the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status(
      `Local segment ${segment}: download requested. Check your Downloads/save dialog. No upload.`,
    );
  }
  function capture() {
    if (stopped || !stream) return;
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mime) throw new Error('Local screen recording format unavailable.');
    const current = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 250000,
      audioBitsPerSecond: 32000,
    });
    recorder = current;
    const chunks: Blob[] = [];
    current.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    current.onerror = () => {
      // Keep onstop attached: MediaRecorder may still deliver a final salvageable
      // blob after an error. Never restart, but offer that partial local segment.
      stop();
      status(
        'Screen recording failed. Check Downloads for previous/final partial segments; the final segment may be incomplete.',
      );
    };
    current.onstop = () => {
      // Start a new container each minute; timeslice fragments alone are not
      // necessarily playable. Save the final partial segment on Stop as well.
      try {
        download(new Blob(chunks, { type: current.mimeType }));
      } catch {
        stop();
        status(
          'Local download could not start. Check download permissions; this segment was not saved.',
        );
      }
      chunks.length = 0;
      if (!stopped) {
        try {
          capture();
        } catch {
          stop();
          status('Screen recording could not continue. Retry recording.');
        }
      }
    };
    current.start();
    timer = setTimeout(() => {
      if (current.state !== 'inactive') current.stop();
    }, 60000);
  }
  async function start() {
    if (started || stopped) return;
    started = true;
    status('Choose a screen to record locally…');
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error(
          'Screen capture is unavailable. Use the updated desktop app or a supported desktop browser.',
        );
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 },
            frameRate: { ideal: 5, max: 5 },
          },
          audio: false,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'NotSupportedError')
          throw new Error(
            'Screen capture is not configured in this desktop build. Quit it and launch the rebuilt recording-fix app.',
          );
        if (name === 'NotAllowedError')
          throw new Error(
            'Screen sharing was cancelled or denied. Choose a screen and allow this app in macOS Privacy & Security → Screen Recording, then reopen it if requested.',
          );
        if (name === 'InvalidStateError')
          throw new Error('Click Start local recording again with the exam window focused.');
        throw error;
      }
      if (stopped) {
        release();
        return;
      }
      // Observe display loss BEFORE waiting for microphone permission. A stopped
      // share must not become a microphone-only recording after the dialog closes.
      screen.getVideoTracks().forEach((track) =>
        track.addEventListener(
          'ended',
          () => {
            stop();
            status(
              'Screen sharing ended. Any captured final segment was requested as a local download.',
            );
          },
          { once: true },
        ),
      );
      if (
        !screen.getVideoTracks().length ||
        screen.getVideoTracks().some((track) => track.readyState === 'ended')
      ) {
        stop();
        throw new Error('Screen sharing ended before recording started.');
      }
      microphone = await acquireBuiltInMicrophone();
      if (stopped) {
        release();
        return;
      }
      stream = new MediaStream([...screen.getVideoTracks(), ...microphone.getAudioTracks()]);
      microphone.getAudioTracks().forEach((track) =>
        track.addEventListener(
          'ended',
          () => {
            stop();
            status('Microphone disconnected. Final local download requested.');
          },
          { once: true },
        ),
      );
      capture();
      status(
        'Recording locally at 720p / up to 5 fps. A download is requested each minute and on Stop.',
      );
    } catch (error) {
      stop();
      throw error;
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (recorder?.state !== 'inactive') recorder?.stop();
    release();
  }
  return { start, stop };
}
