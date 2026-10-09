import { useEffect, useRef, useState } from 'react';
import type { AttemptContext } from './browserIntegrity.js';
import { createCameraSession, emptyCamera } from './cameraSession.js';
import { cameraEnvironment } from './cameraEnvironment.js';
import { faceDirection } from './faceDirection.js';

export function CameraIntegrityPanel({ attempt }: { readonly attempt: AttemptContext }) {
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef(attempt);
  current.current = attempt;
  const controller = useRef<ReturnType<typeof createCameraSession> | null>(null);
  const [snapshot, setSnapshot] = useState(emptyCamera);
  const [cameraLabel, setCameraLabel] = useState('');
  const objects = true;
  const [lowLight, setLowLight] = useState(false);
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
    // This panel mounts only after the exam consent gate. Capture stays bounded
    // to one outstanding frame so model work cannot accumulate behind the UI.
    if (attempt.active) void session.start(true);
    return () => {
      session.destroy();
      controller.current = null;
    };
  }, [attempt.id, attempt.active, objects]);

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
        Camera checks start after consent and run at most once per second. Missing models are not
        treated as clear results.
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
                  ? 'Unavailable — detector model not loaded'
                  : snapshot.earbuds
                    ? 'Detected'
                    : 'Not observed'}
              </p>
              <p>
                Smart glasses:{' '}
                {snapshot.smartGlasses === null
                  ? 'Unavailable — detector model not loaded'
                  : snapshot.smartGlasses
                    ? 'Detected'
                    : 'Not observed'}
              </p>
              <p>Wired earphones / headphones: unavailable — no compatible detector installed</p>
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
