import { useEffect, useRef, useState } from 'react';
import type { AttemptContext } from './browserIntegrity.js';
import { createCameraSession, emptyCamera } from './cameraSession.js';
import { cameraEnvironment } from './cameraEnvironment.js';
import { faceDirection } from './faceDirection.js';
import { createGazeReporter } from './gazeReporter.js';
import type { ExamApi } from '../exam/api.js';
import {
  captureVisionFrame,
  serverVisionText,
  startServerVision,
  type ServerVisionStatus,
} from './serverVision.js';

export function CameraIntegrityPanel({
  attempt,
  autoStart = false,
  api,
}: {
  readonly attempt: AttemptContext;
  /** Start once on mount when consent was given; a failure is never retried. */
  readonly autoStart?: boolean;
  /** Used for the opt-in server (OWL-ViT) second opinion; omitted means browser checks only. */
  readonly api?:
    | (Pick<ExamApi, 'getServerVisionEnabled' | 'postVisionCheck'> &
        Partial<Pick<ExamApi, 'uploadTelemetry' | 'patchEvents'>>)
    | undefined;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef(attempt);
  current.current = attempt;
  const controller = useRef<ReturnType<typeof createCameraSession> | null>(null);
  const [snapshot, setSnapshot] = useState(emptyCamera);
  const [cameraLabel, setCameraLabel] = useState('');
  const objects = true;
  const [lowLight, setLowLight] = useState(false);
  const [serverVision, setServerVision] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerVisionStatus>({ state: 'not_checked' });
  const live = snapshot.phase === 'live';
  const running = snapshot.phase !== 'off';
  const readings = live && snapshot.faces !== null;

  useEffect(() => {
    if (!video.current) return;
    const session = createCameraSession(
      cameraEnvironment(video.current, setCameraLabel, objects),
      () => current.current,
      setSnapshot,
    );
    controller.current = session;
    setSnapshot(emptyCamera());
    setLowLight(false);
    // Auto-start runs once per attempt (never from a retry loop). Capture stays
    // bounded to one outstanding frame so model work cannot accumulate.
    if (autoStart && attempt.active) void session.start(true).catch(() => {});
    return () => {
      session.destroy();
      controller.current = null;
    };
  }, [attempt.id, attempt.active, autoStart, objects]);

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
    if (!live) {
      reporter.current?.pause();
      return;
    }
    reporter.current?.sample({
      faces: snapshot.faces,
      pose: snapshot.relative ?? snapshot.pose,
      phone: snapshot.phone,
    });
  }, [live, snapshot]);

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

  useEffect(() => {
    if (!live) {
      setLowLight(false);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    const interval = setInterval(() => {
      const element = video.current;
      if (!context || !element || element.readyState < 2) return;
      try {
        context.drawImage(element, 0, 0, 80, 60);
        const pixels = context.getImageData(0, 0, 80, 60).data;
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4)
          total += 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
        setLowLight(total / (80 * 60) < 45);
      } catch {
        setLowLight(false);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [live]);

  return (
    <section className="cam-panel" aria-label="Camera checks">
      <p role="status">{snapshot.reason}</p>
      <div className="cam-controls">
        <button
          type="button"
          disabled={!attempt.active}
          onClick={() =>
            running ? controller.current?.stop() : void controller.current?.start(true)
          }
        >
          {running ? 'Stop camera checks' : 'Start camera checks'}
        </button>
      </div>
      <p className="muted">
        Camera checks start automatically when the exam opens (you can stop and restart them) and
        run at most once per second. Missing models are not treated as clear results.
      </p>
      <div className="cam-preview">
        <video
          ref={video}
          muted
          playsInline
          aria-label="Camera preview"
          style={{ display: live ? 'block' : 'none' }}
        />
        {!live && (
          <p>
            {running
              ? 'Preparing camera checks… You can continue navigating questions.'
              : 'Camera off'}
          </p>
        )}
        {live && <span className="cam-badge cam-badge--live">Camera active</span>}
      </div>
      {live && <p>{cameraLabel}</p>}
      {live && serverVision && <p className="muted">{serverVisionText(serverStatus)}</p>}
      {lowLight && (
        <p role="alert">
          Low light: brighten the room for a usable face estimate. Setup controls remain available.
        </p>
      )}
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
              <p>
                Earbuds:{' '}
                {snapshot.earbuds === null
                  ? 'Not checked — browser model not installed'
                  : snapshot.earbuds
                    ? 'Detected'
                    : 'Not observed'}
              </p>
              <p>
                Smart glasses:{' '}
                {snapshot.smartGlasses === null
                  ? 'Not checked — browser model not installed'
                  : snapshot.smartGlasses
                    ? 'Detected'
                    : 'Not observed'}
              </p>
              <p>Wired earphones / headphones: not checked — no browser model installed</p>
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
      <p className="muted">
        Direction is relative to your calibrated pose and camera coordinates—not eye gaze or proof
        of cheating.
      </p>
    </section>
  );
}
