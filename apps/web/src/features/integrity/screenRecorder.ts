import { ExamApiError, type ExamApi } from '../exam/api.js';
import { acquireBuiltInMicrophone } from './builtInMicrophone.js';
import {
  LOCAL_PROFILE,
  PROFILES,
  applyConnectionHint,
  chooseProfile,
  probeUploadKbps,
  profileRank,
  readConnectionHint,
  stepDown,
  stepUp,
  type ProfileName,
  type RecordingProfile,
} from './networkProbe.js';
import { RecordingUploadQueue, type QueueItem } from './recordingUploadQueue.js';

export const CLOUD_SEGMENT_MS = 10_000;
export const LOCAL_SEGMENT_MS = 60_000;
const STEP_COOLDOWN_MS = 30_000;
const STEP_UP_QUIET_MS = 120_000;
const FLUSH_AFTER_STOP_MS = 60_000;
const DOWNLOAD_SPACING_MS = 400;
const REPROBE_LOCAL_MS = 120_000;
const THROUGHPUT_SAMPLES = 4;

export interface ScreenRecorderOptions {
  /** Returns upload kbps or null; used before recording and while saving locally. Defaults to timing /exam/speedtest. */
  readonly probe?: () => Promise<number | null>;
  /** Blob to base64 for upload; defaults to FileReader. */
  readonly encode?: (blob: Blob) => Promise<string>;
  readonly now?: () => number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read segment.'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ''));
    reader.readAsDataURL(blob);
  });
}

/**
 * Opt-in screen recording. Segments are uploaded in the background when the
 * connection allows (quality adapts), otherwise saved on the student's computer.
 * Recording problems never block or interrupt the exam.
 */
export function createScreenRecorder(
  attemptId: string,
  examApi?: ExamApi,
  status: (message: string) => void = () => {},
  options: ScreenRecorderOptions = {},
) {
  const now = options.now ?? Date.now;
  const encode = options.encode ?? blobToBase64;
  let stopped = false;
  let started = false;
  let screen: MediaStream | null = null;
  let microphone: MediaStream | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let segmentIndex = 0;
  let mode: 'cloud' | 'local' = 'local';
  let profile: RecordingProfile = PROFILES.low;
  let lastStepAt = now();
  let lastBusyAt = now();
  let reprobing = false;
  let notice = '';
  let queue: RecordingUploadQueue | null = null;
  let reprobeTimer: ReturnType<typeof setTimeout> | null = null;
  let downloadTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDownloadAt = -Infinity;
  const downloads: Array<{ blob: Blob; index: number }> = [];
  /** Recent segment uploads (bits sent, milliseconds taken) used to estimate throughput. */
  let uploadSamples: Array<{ bits: number; ms: number }> = [];
  const session = new Date().toISOString().replace(/[:.]/g, '-');

  function release() {
    screen?.getTracks().forEach((track) => track.stop());
    microphone?.getTracks().forEach((track) => track.stop());
  }

  function report() {
    if (mode === 'local') {
      status(
        notice ||
          'Recording on this computer • segments are saved to your Downloads, not uploaded.',
      );
      return;
    }
    const uploaded = queue?.uploaded ?? 0;
    const total = queue?.total ?? 0;
    const waiting = queue?.waiting ?? 0;
    const lead = stopped ? 'Recording stopped' : 'Recording';
    status(
      `${lead} • ${profile.label} • uploaded ${uploaded}/${total}` +
        (waiting > 0 ? ` • ${waiting} waiting` : ''),
    );
  }

  // Browsers block several downloads fired at once, so save one every ~400 ms.
  function download(blob: Blob, index: number) {
    if (!blob.size) return;
    downloads.push({ blob, index });
    pumpDownloads();
  }

  function pumpDownloads() {
    if (downloadTimer || downloads.length === 0) return;
    const wait = Math.max(0, lastDownloadAt + DOWNLOAD_SPACING_MS - now());
    if (wait > 0) {
      downloadTimer = setTimeout(() => {
        downloadTimer = null;
        pumpDownloads();
      }, wait);
      return;
    }
    const next = downloads.shift()!;
    lastDownloadAt = now();
    saveToDisk(next.blob, next.index);
    pumpDownloads();
  }

  function saveToDisk(blob: Blob, index: number) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exam-demo-${session}-${index + 1}.webm`;
    document.body.append(link);
    link.click();
    link.remove();
    // Allow the download handler to acquire the blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function goLocal(pending: QueueItem[], message: string, canResume = true) {
    mode = 'local';
    notice = message;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    for (const item of pending) download(item.blob, item.index);
    applyProfileToTrack({ ...LOCAL_PROFILE });
    if (canResume) scheduleReprobe();
    report();
  }

  // After a blip we saved locally; try the network again every 2 minutes.
  function scheduleReprobe() {
    if (reprobeTimer || stopped || !examApi) return;
    reprobeTimer = setTimeout(() => {
      reprobeTimer = null;
      void tryResumeCloud().catch(() => {});
    }, REPROBE_LOCAL_MS);
  }

  async function tryResumeCloud() {
    if (stopped || mode !== 'local' || !examApi) return;
    const kbps = await (options.probe ?? (() => probeUploadKbps(examApi)))().catch(() => null);
    if (stopped || mode !== 'local') return;
    const choice = applyConnectionHint(chooseProfile(kbps), readConnectionHint());
    if (choice === 'local-only') {
      scheduleReprobe();
      return;
    }
    mode = 'cloud';
    notice = '';
    profile = PROFILES[choice];
    uploadSamples = [];
    lastStepAt = lastBusyAt = now();
    startQueue(examApi);
    applyProfileToTrack(profile);
    // Close the long local segment now so the next one is a short cloud segment.
    if (timer) clearTimeout(timer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    report();
  }

  function estimatedKbps(): number | null {
    if (uploadSamples.length < 2) return null;
    const bits = uploadSamples.reduce((sum, sample) => sum + sample.bits, 0);
    const ms = uploadSamples.reduce((sum, sample) => sum + sample.ms, 0);
    return bits / Math.max(1, ms);
  }

  function applyProfileToTrack(target: { width: number; height: number; frameRate: number }) {
    for (const track of screen?.getVideoTracks() ?? []) {
      // Resolution changes are best effort; the encoder bitrate is what protects the uplink.
      void track
        .applyConstraints?.({
          width: { ideal: target.width, max: target.width },
          height: { ideal: target.height, max: target.height },
          frameRate: { ideal: target.frameRate, max: target.frameRate },
        })
        ?.catch(() => {});
    }
  }

  function changeProfile(next: ProfileName) {
    if (next === profile.name) return;
    profile = PROFILES[next];
    lastStepAt = now();
    lastBusyAt = lastStepAt;
    applyProfileToTrack(profile);
    report();
  }

  function onPressure() {
    lastBusyAt = now();
    if (now() - lastStepAt < STEP_COOLDOWN_MS) return;
    changeProfile(stepDown(profile.name));
  }

  async function maybeStepUp() {
    if (reprobing || mode !== 'cloud' || !examApi || profile.name === 'high') return;
    if (now() - lastBusyAt < STEP_UP_QUIET_MS || now() - lastStepAt < STEP_UP_QUIET_MS) return;
    reprobing = true;
    try {
      // Real segment upload timings; no extra probe traffic while recording.
      const kbps = estimatedKbps();
      if (kbps === null) return;
      const choice = applyConnectionHint(chooseProfile(kbps), readConnectionHint());
      if (stopped || mode !== 'cloud' || choice === 'local-only') return;
      if (profileRank(choice) > profileRank(profile.name)) changeProfile(stepUp(profile.name));
      else lastBusyAt = now();
    } finally {
      reprobing = false;
    }
  }

  function handleSegment(blob: Blob) {
    const index = segmentIndex++;
    if (!blob.size) return;
    if (mode === 'cloud' && queue && !queue.isDead) {
      if (queue.waiting > 0) lastBusyAt = now();
      queue.enqueue({ index, blob });
      armFlush();
      return;
    }
    download(blob, index);
    report();
  }

  // After Stop, queued segments may finish uploading, but never get lost on a bad link.
  function armFlush() {
    if (!stopped || flushTimer || mode !== 'cloud' || !queue || queue.isDead) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!queue || queue.isDead || queue.waiting === 0) return;
      goLocal(
        queue.drainPending(),
        'Some segments could not finish uploading, so they were saved on your computer (Downloads).',
      );
    }, FLUSH_AFTER_STOP_MS);
  }

  function startQueue(api: ExamApi) {
    queue = new RecordingUploadQueue({
      segmentMs: CLOUD_SEGMENT_MS,
      now,
      upload: async (item) => {
        const encoded = await encode(item.blob);
        const began = now();
        await api.uploadRecordingChunk(attemptId, item.index, encoded);
        uploadSamples = [
          ...uploadSamples,
          { bits: encoded.length * 8, ms: Math.max(1, now() - began) },
        ].slice(-THROUGHPUT_SAMPLES);
      },
      // Not configured / rejected / duplicate index: retrying will not help, keep the footage locally.
      isFatal: (error) =>
        error instanceof ExamApiError && [400, 403, 404, 409, 503].includes(error.status ?? 0),
      onChange: report,
      onPressure,
      onOverflow: (item) => download(item.blob, item.index),
      onGiveUp: (pending, reason) =>
        goLocal(
          pending,
          reason === 'fatal'
            ? 'Cloud recording is unavailable, so segments are being saved on your computer (Downloads) instead.'
            : 'Your connection was not steady enough to upload, so segments are being saved on your computer (Downloads) instead. Trying the network again shortly.',
          reason === 'unstable',
        ),
    });
  }

  function capture() {
    if (stopped || !stream) return;
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mime) throw new Error('Screen recording format unavailable.');
    const bitrate =
      mode === 'cloud' ? profile.videoBitsPerSecond : LOCAL_PROFILE.videoBitsPerSecond;
    const current = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 32000,
    });
    recorder = current;
    const chunks: Blob[] = [];
    current.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    current.onerror = () => {
      // Keep onstop attached: MediaRecorder may still deliver a final salvageable
      // blob after an error. Never restart, but keep that partial segment.
      stop();
      status(
        'Screen recording stopped unexpectedly. Earlier segments were kept; the last one may be incomplete.',
      );
    };
    current.onstop = () => {
      // Each segment is its own container so it is independently playable.
      try {
        handleSegment(new Blob(chunks, { type: current.mimeType }));
      } catch {
        stop();
        status('A recording segment could not be saved. Check download permissions.');
      }
      chunks.length = 0;
      if (!stopped) {
        try {
          capture();
          void maybeStepUp().catch(() => {});
        } catch {
          stop();
          status('Screen recording could not continue. You can retry recording.');
        }
      }
    };
    current.start();
    timer = setTimeout(
      () => {
        if (current.state !== 'inactive') current.stop();
      },
      mode === 'cloud' ? CLOUD_SEGMENT_MS : LOCAL_SEGMENT_MS,
    );
  }

  async function start() {
    if (started || stopped) return;
    started = true;
    status('Choose a screen to record…');
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error(
          'Screen capture is unavailable. Use the updated desktop app or a supported desktop browser.',
        );
      try {
        // Ask for the screen first (needs the student's click), then adapt to the network.
        const initial = PROFILES.standard;
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: initial.width, max: initial.width },
            height: { ideal: initial.height, max: initial.height },
            frameRate: { ideal: initial.frameRate, max: initial.frameRate },
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
          throw new Error('Click Start recording again with the exam window focused.');
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
            status('Screen sharing ended. Segments captured so far were kept.');
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
            status('Microphone disconnected. Segments captured so far were kept.');
          },
          { once: true },
        ),
      );

      // Choose quality from measured upload speed; any failure means local-only.
      if (examApi) {
        status('Checking your connection…');
        const kbps = await (options.probe ?? (() => probeUploadKbps(examApi)))().catch(() => null);
        if (stopped) {
          release();
          return;
        }
        const choice = applyConnectionHint(chooseProfile(kbps), readConnectionHint());
        if (choice === 'local-only') {
          notice =
            'Could not reach the server to upload, so recording on this computer instead (segments saved to Downloads).';
          scheduleReprobe();
        } else {
          mode = 'cloud';
          profile = PROFILES[choice];
          startQueue(examApi);
        }
      }
      lastStepAt = lastBusyAt = now();
      applyProfileToTrack(mode === 'cloud' ? profile : { ...LOCAL_PROFILE });
      capture();
      report();
    } catch (error) {
      stop();
      throw error;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (reprobeTimer) clearTimeout(reprobeTimer);
    reprobeTimer = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    release();
    armFlush();
    if (recorder) report();
  }
  return { start, stop };
}
