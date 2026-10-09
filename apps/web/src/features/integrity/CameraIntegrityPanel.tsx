import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptContext } from './browserIntegrity.js';
import { createCameraSession, emptyCamera } from './cameraSession.js';
import { cameraEnvironment } from './cameraEnvironment.js';
import { faceDirection } from './faceDirection.js';
import { createGazeReporter } from './gazeReporter.js';
import { useEvidenceCapture } from '../evidence/useEvidenceCapture.js';
import { createEyeGazeTracker } from './eyeGazeTracker.js';
import type { GazeSample } from './gazeEstimator.js';
import { GazePanel } from './GazePanel.js';
import type { ExamApi } from '../exam/api.js';
import type { Box } from './gazeEstimator.js';
import { brightnessTip, useBrightnessState } from './desktopBrightness.js';
import { tuneCameraTrack } from './cameraTuning.js';
import { isLightBoostOn, setLightBoost, useLightBoost } from './lightBoost.js';
import { analyseLighting, lightingEventName, type LightingReport } from './lightingAnalysis.js';
import { createLightingTracker, LIGHTING_SAMPLE_INTERVAL_MS } from './lightingMonitor.js';
import { sampleVideoLighting } from './lightingSampler.js';
import {
  captureVisionFrame,
  serverVisionText,
  startServerVision,
  type ServerVisionStatus,
} from './serverVision.js';

/** An eye-gaze sample older than this no longer counts as current. */
const GAZE_FRESH_MS = 1500;

export function CameraIntegrityPanel({
  attempt,
  autoStart = false,
  api,
  onGazeSample,
  paused = false,
}: {
  readonly attempt: AttemptContext;
  /**
   * Eye-gaze hook: called for every smoothed, calibrated gaze sample (about 2-4 per second while
   * one face is visible). Debounce before logging. Never receives images.
   */
  readonly onGazeSample?: (sample: GazeSample) => void;
  /**
   * True while the camera gate has paused answering: no evidence snapshots are taken and no
   * gaze events are logged until it resumes.
   */
  readonly paused?: boolean;
  /** Start once on mount when consent was given; a failure is never retried. */
  readonly autoStart?: boolean;
  /** Used for the opt-in server (OWL-ViT) second opinion; omitted means browser checks only. */
  readonly api?:
    | (Pick<ExamApi, 'getServerVisionEnabled' | 'postVisionCheck'> &
        Partial<Pick<ExamApi, 'uploadTelemetry' | 'patchEvents' | 'postEvidence'>>)
    | undefined;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef(attempt);
  current.current = attempt;
  const controller = useRef<ReturnType<typeof createCameraSession> | null>(null);
  const onGaze = useRef(onGazeSample);
  onGaze.current = onGazeSample;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** Latest eye-gaze sample; ignored once older than GAZE_FRESH_MS (tracking lost). */
  const latestGaze = useRef<GazeSample | null>(null);
  const freshGaze = (): GazeSample | null => {
    const sample = latestGaze.current;
    return sample !== null && performance.now() - sample.t <= GAZE_FRESH_MS ? sample : null;
  };
  const gazeTracker = useMemo(
    () =>
      createEyeGazeTracker({
        onSample: (sample) => {
          latestGaze.current = sample;
          try {
            onGaze.current?.(sample);
          } catch {
            // A consumer error must never stop camera checks.
          }
        },
      }),
    // A fresh tracker (statistics + calibration) per attempt.
    [attempt.id],
  );
  const [snapshot, setSnapshot] = useState(emptyCamera);
  const [cameraLabel, setCameraLabel] = useState('');
  const objects = true;
  const [lightingBanner, setLightingBanner] = useState<LightingReport | null>(null);
  const brightness = useBrightnessState();
  const lightBoost = useLightBoost();
  /** Latest MediaPipe face box (normalised) and when it arrived; ignored once stale. */
  const latestFaceBox = useRef<{ box: Box; at: number } | null>(null);
  const [serverVision, setServerVision] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerVisionStatus>({ state: 'not_checked' });
  useEvidenceCapture({
    attemptId: attempt.id,
    active: attempt.active && !paused,
    snapshot,
    video,
    api,
    gaze: freshGaze,
  });
  const ended = !attempt.active;
  const live = snapshot.phase === 'live';
  const running = snapshot.phase !== 'off';
  const readings = live && snapshot.faces !== null;

  useEffect(() => {
    if (!video.current) return;
    const session = createCameraSession(
      cameraEnvironment(video.current, setCameraLabel, objects),
      () => current.current,
      setSnapshot,
      (sample) => {
        const box = sample.observation.faceBox;
        latestFaceBox.current = box ? { box, at: performance.now() } : null;
        gazeTracker.push(sample);
      },
    );
    controller.current = session;
    gazeTracker.reset();
    latestGaze.current = null;
    setSnapshot(emptyCamera());
    // Auto-start runs once per attempt (never from a retry loop). Capture stays
    // bounded to one outstanding frame so model work cannot accumulate.
    if (autoStart && attempt.active) void session.start(true).catch(() => {});
    return () => {
      session.destroy();
      controller.current = null;
    };
  }, [attempt.id, attempt.active, autoStart, objects, gazeTracker]);

  // Debounced direction / face-count / phone events go to the unified integrity log.
  const reporter = useRef<ReturnType<typeof createGazeReporter> | null>(null);
  useEffect(() => {
    const upload = api?.uploadTelemetry;
    const patch = api?.patchEvents;
    if (!api || !upload || !patch || !attempt.active) return;
    const created = createGazeReporter(attempt.id, {
      uploadTelemetry: (id, payload) => upload.call(api, id, payload),
      patchEvents: (id, body) => patch.call(api, id, body),
    });
    reporter.current = created;
    return () => {
      created.stop();
      reporter.current = null;
    };
  }, [attempt.id, attempt.active, api]);
  useEffect(() => {
    if (!live || paused) {
      reporter.current?.pause();
      return;
    }
    // Prefer the eye-gaze signal (head + iris, calibrated); fall back to head pose.
    const gaze = freshGaze();
    reporter.current?.sample({
      faces: snapshot.faces,
      pose: gaze ? { yaw: gaze.yaw, pitch: gaze.pitch } : (snapshot.relative ?? snapshot.pose),
      phone: snapshot.phone,
    });
  }, [live, snapshot, paused]);

  useEffect(() => {
    if (!api?.getServerVisionEnabled) return;
    const abort = new AbortController();
    api
      .getServerVisionEnabled(abort.signal)
      .then((enabled) => !abort.signal.aborted && setServerVision(enabled))
      .catch(() => {});
    return () => abort.abort();
  }, [api]);

  useEffect(() => {
    setServerStatus({ state: 'not_checked' });
    const postVisionCheck = api?.postVisionCheck;
    if (!serverVision || !live || !attempt.active || !postVisionCheck) return;
    const scheduler = startServerVision({
      capture: () => captureVisionFrame(video.current),
      send: async (image, signal) => postVisionCheck.call(api, current.current.id, image, signal),
      onStatus: setServerStatus,
    });
    return () => scheduler.stop();
  }, [serverVision, live, attempt.active, attempt.id, api]);

  // Lighting monitor: sample every ~5 s; a face that stays too dark or backlit for 20 s gets a
  // non-blocking banner (and an informational timeline entry). It never blocks the exam.
  useEffect(() => {
    if (!live || !attempt.active) {
      setLightingBanner(null);
      return;
    }
    const tracker = createLightingTracker();
    let tuned = false;
    let busy = false;
    let stopped = false;
    const tick = async (): Promise<void> => {
      const element = video.current;
      if (busy || !element || pausedRef.current) return;
      busy = true;
      try {
        const sample = await sampleVideoLighting(element);
        if (!sample || stopped) return;
        const faceBox =
          latestFaceBox.current && performance.now() - latestFaceBox.current.at < 1500
            ? latestFaceBox.current.box
            : null;
        const report = analyseLighting({
          frames: sample.frames,
          width: sample.width,
          height: sample.height,
          faceBox,
        });
        const verdict = tracker.observe(report);
        setLightingBanner(verdict.banner);
        if (verdict.banner?.class === 'too_dark' && !isLightBoostOn()) setLightBoost(true);
        if (verdict.banner && !tuned) {
          tuned = true;
          const stream = element.srcObject;
          if (stream instanceof MediaStream)
            void tuneCameraTrack(stream.getVideoTracks()[0], { dim: true });
        }
        if (verdict.log) {
          const patch = api?.patchEvents;
          void patch
            ?.call(api, current.current.id, { event: lightingEventName(verdict.log.class) })
            .catch(() => {});
        }
      } finally {
        busy = false;
      }
    };
    const interval = setInterval(() => void tick(), LIGHTING_SAMPLE_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
      setLightingBanner(null);
      setLightBoost(false);
    };
  }, [live, attempt.active, api]);

  return (
    <section className="cam-panel" aria-label="Camera checks">
      {ended ? null : (
        <>
          <p role="status">{snapshot.reason}</p>
          <div className="cam-controls">
            <button
              type="button"
              onClick={() =>
                running ? controller.current?.stop() : void controller.current?.start(true)
              }
            >
              {running ? 'Stop camera checks' : 'Start camera checks'}
            </button>
          </div>
          <p className="muted">
            Camera checks start automatically when the exam opens (you can stop and restart them)
            and run a few times per second on this device. Missing models are not treated as clear
            results.
          </p>
        </>
      )}
      <div className="cam-preview">
        <video
          ref={video}
          muted
          playsInline
          aria-label="Camera preview"
          style={{ display: live ? 'block' : 'none' }}
        />
        {!live && (
          <p className="cam-preview-note">
            {running
              ? 'Preparing camera checks… You can continue navigating questions.'
              : ended
                ? 'Monitoring ended'
                : 'Camera off'}
          </p>
        )}
        {live && <span className="cam-badge cam-badge--live">Camera active</span>}
      </div>
      {live && <p>{cameraLabel}</p>}
      {live && serverVision && <p className="muted">{serverVisionText(serverStatus)}</p>}
      {lightingBanner && (
        <div className="lighting-banner" role="alert">
          <strong>{lightingBanner.headline}.</strong> {lightingBanner.tips.slice(0, 2).join(' ')}{' '}
          Face tracking works best in good light. You can keep answering.
          <button
            type="button"
            aria-pressed={lightBoost}
            onClick={() => setLightBoost(!lightBoost)}
          >
            {lightBoost ? 'Turn off boost light' : 'Boost light'}
          </button>
        </div>
      )}
      {brightnessTip(brightness) !== '' && <p className="muted">{brightnessTip(brightness)}</p>}
      {live && !readings && (
        <p role="status">Waiting for a fresh vision result. No current readings.</p>
      )}
      {readings && (
        <div className="cam-readings">
          <p>Faces: {snapshot.faces}</p>
          <p>
            <strong>
              Face direction:{' '}
              {snapshot.faces === 1
                ? faceDirection(snapshot.relative)
                : 'Unavailable — one face is required'}
            </strong>
          </p>
          {snapshot.relative && (
            <p>
              Yaw {snapshot.relative.yaw}° · Pitch {snapshot.relative.pitch}°
            </p>
          )}
          {objects && (
            <>
              <p>
                Phone:{' '}
                {snapshot.phone === 'unavailable'
                  ? 'Detector unavailable'
                  : snapshot.phone === 'observed'
                    ? 'Detected'
                    : snapshot.phone === 'candidate'
                      ? 'Possible phone'
                      : snapshot.phone === 'not_observed'
                        ? 'Not observed'
                        : 'Waiting for result'}
              </p>
              {/* Accessory rows appear only when something can actually check them. */}
              {(serverVision || snapshot.earbuds !== null) && (
                <p>
                  Earbuds:{' '}
                  {snapshot.earbuds === null
                    ? 'Not available in this version'
                    : snapshot.earbuds
                      ? 'Detected'
                      : 'Not observed'}
                </p>
              )}
              {(serverVision || snapshot.smartGlasses !== null) && (
                <p>
                  Smart glasses:{' '}
                  {snapshot.smartGlasses === null
                    ? 'Not available in this version'
                    : snapshot.smartGlasses
                      ? 'Detected'
                      : 'Not observed'}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {live && (
        <button
          type="button"
          disabled={!readings || snapshot.faces !== 1}
          onClick={() => controller.current?.calibrate()}
        >
          Calibrate face direction
        </button>
      )}
      <GazePanel tracker={gazeTracker} live={live} />
      <p className="muted">
        Direction is relative to your calibrated pose and camera coordinates—not eye gaze or proof
        of cheating.
      </p>
    </section>
  );
}
