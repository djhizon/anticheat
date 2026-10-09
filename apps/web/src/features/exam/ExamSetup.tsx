import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExamApi } from './api.js';
import { ConsentList, NO_PAUSE_STATEMENT, recordingStorageStatement } from './ConsentList.js';
import {
  SETUP_STEPS,
  canAdvance,
  clampStep,
  loadSetupProgress,
  nextStep,
  permissionFixSteps,
  previousStep,
  saveSetupProgress,
  stepIndex,
  type SetupChecks,
  type SetupStepId,
} from './setupFlow.js';
import { acquireBuiltInMicrophone } from '../integrity/builtInMicrophone.js';
import { CameraGatePanel, useCameraGate } from '../integrity/CameraGatePanel.js';
import { createLevelMeter } from '../integrity/audioLevel.js';
import { LightingCheckPanel } from '../integrity/LightingCheckPanel.js';
import { LivenessModal } from '../integrity/LivenessModal.js';
import { startSetupTypingCapture } from '../input/typingBaseline.js';
import { PhonePairingPanel } from '../integrity/PhonePairingPanel.js';
import { holdSensorStreams, releaseSensorStreams } from '../integrity/sensorHub.js';
import { usePhonePresence } from '../integrity/usePhonePresence.js';
import { desktopAppsBridge, readCameraAttestation } from '../integrity/desktopApps.js';
import { useFaceInView } from '../integrity/faceInView.js';
import { LIGHTING_TIPS } from '../integrity/lightingAnalysis.js';
import {
  startScreenRecording,
  stopScreenRecording,
  useScreenRecording,
} from '../integrity/screenRecordingSession.js';

/** Input level (0..1) that counts as "we can hear you". */
export const MIC_LEVEL_THRESHOLD = 0.04;
/** Without input for this long the student is told we cannot hear them. */
export const MIC_SILENCE_MS = 5000;
/** After this many failed presence checks (any method) the student may continue for review. */
export const IDENTITY_MAX_FAILURES = 3;
/** "Paired ✓" stays visible this long before setup moves on by itself. */
export const PAIRED_ADVANCE_MS = 1200;

type PermissionState = 'unknown' | 'granted' | 'denied';

export interface SetupResult {
  readonly attemptId: string;
  readonly identityVerified: boolean;
}

export interface ExamSetupProps {
  /** Progress is stored per assignment so a refresh resumes on the right step. */
  readonly assignmentId: string;
  readonly title: string;
  readonly examApi: ExamApi;
  /** Known when the attempt already exists (setup resumed); otherwise created after consent. */
  readonly attemptId: string | null;
  /** Creates the (untimed) attempt once the student consented; resolves to its id. */
  readonly ensureAttempt: () => Promise<string>;
  /** Starts the exam timer. Rejects if it could not be started. */
  readonly onBegin: (result: SetupResult) => Promise<void>;
  readonly onCancel: () => void;
  /** False when the exam keeps screen recordings on this computer (no OneDrive upload). */
  readonly recordingUpload?: boolean;
}

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? String((error as { name?: unknown }).name ?? '')
    : '';
}

async function requestOne(kind: 'camera' | 'microphone'): Promise<PermissionState> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'camera' ? { video: true, audio: false } : { audio: true, video: false },
    );
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (error) {
    // A missing device is not a permission problem; it is reported by the later checks.
    return errorName(error) === 'NotFoundError' ? 'granted' : 'denied';
  }
}

async function queryPermission(kind: 'camera' | 'microphone'): Promise<PermissionState> {
  try {
    const status = await navigator.permissions.query({ name: kind as PermissionName });
    return status.state === 'granted'
      ? 'granted'
      : status.state === 'denied'
        ? 'denied'
        : 'unknown';
  } catch {
    return 'unknown';
  }
}

function MicrophoneMeter({
  stream,
  onHeard,
}: {
  readonly stream: MediaStream;
  readonly onHeard: () => void;
}) {
  const [level, setLevel] = useState(0);
  const heard = useRef(onHeard);
  heard.current = onHeard;
  useEffect(() => {
    return createLevelMeter(stream, (reading) => {
      setLevel(reading.level);
      if (reading.level >= MIC_LEVEL_THRESHOLD) heard.current();
    });
  }, [stream]);
  return (
    <progress
      className="setup-meter"
      aria-label="Microphone input level"
      max={1}
      value={Math.min(1, level * 4)}
    />
  );
}

export function ExamSetup({
  assignmentId,
  title,
  examApi,
  attemptId: initialAttemptId,
  ensureAttempt,
  onBegin,
  onCancel,
  recordingUpload = true,
}: ExamSetupProps): React.ReactElement {
  // Typing-rhythm statistics (no keys, no text) collected while setup is open become the baseline
  // the exam compares against; the capture stops when the student presses Start exam.
  const stopTypingCapture = useRef<(() => unknown) | null>(null);
  useEffect(() => {
    const stop = startSetupTypingCapture();
    stopTypingCapture.current = stop;
    return () => {
      if (stopTypingCapture.current === stop) stopTypingCapture.current = null;
      stop();
    };
  }, []);
  const [saved] = useState(() => loadSetupProgress(assignmentId));
  const [attemptId, setAttemptId] = useState<string | null>(initialAttemptId);
  const [requested, setRequested] = useState<SetupStepId>(saved.step);
  const [consent, setConsent] = useState(saved.consent);
  const [phone, setPhone] = useState(saved.phone);
  const [pairingShown, setPairingShown] = useState(false);
  const [identity, setIdentity] = useState(saved.identity);
  const [identityUnverified, setIdentityUnverified] = useState(saved.identityUnverified === true);
  const [identityFailures, setIdentityFailures] = useState(0);
  const [permissions, setPermissions] = useState<{
    camera: PermissionState;
    microphone: PermissionState;
  }>({ camera: 'unknown', microphone: 'unknown' });
  const [permissionBusy, setPermissionBusy] = useState(false);
  // Lets the camera gate log an unverified (non-attested) camera against the setup attempt.
  const attemptRef = useRef<string | null>(null);
  attemptRef.current = attemptId;
  const gate = useCameraGate({
    report: (event) => {
      const id = attemptRef.current;
      if (id) void examApi.patchEvents(id, { event }).catch(() => undefined);
    },
  });
  const runGate = gate.run;
  const [lightingOk, setLightingOk] = useState(false);
  // Camera step: the desktop app's own camera check (when it has one), then a face in view.
  const [attestation, setAttestation] = useState<'pending' | 'ok' | 'virtual'>('pending');
  const gateLabel = gate.state.phase === 'ok' ? gate.state.label : null;
  useEffect(() => {
    if (gateLabel === null) {
      setAttestation('pending');
      return;
    }
    let cancelled = false;
    setAttestation('pending');
    void readCameraAttestation(gateLabel).then((result) => {
      if (!cancelled) setAttestation(result === 'virtual' ? 'virtual' : 'ok');
    });
    return () => {
      cancelled = true;
    };
  }, [gateLabel, gate.stream]);
  const cameraValid = gate.state.phase === 'ok' && attestation === 'ok';
  const [faceOk, setFaceOk] = useState(false);
  const [faceAttempt, setFaceAttempt] = useState(0);
  useEffect(() => setFaceOk(false), [gate.stream]);
  // Screen recording (mandatory): started by the student's click on the screen step.
  const recording = useScreenRecording();
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState('');
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [micHeard, setMicHeard] = useState(false);
  const [micSilent, setMicSilent] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState('');
  const micRef = useRef<MediaStream | null>(null);
  // After a refresh past the hardware steps, camera and microphone are re-acquired quietly.
  const [restoring, setRestoring] = useState(stepIndex(saved.step) >= stepIndex('screen'));
  const [restoreNote, setRestoreNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true);

  const screenRunning = recording.phase === 'running' && recording.attemptId === attemptId;
  const checks: SetupChecks = {
    consent,
    permissions: permissions.camera === 'granted' && permissions.microphone === 'granted',
    camera: cameraValid,
    face: faceOk,
    lighting: lightingOk,
    microphone: micStream !== null && micHeard,
    screen: screenRunning,
    phone,
    identity,
  };
  const step = restoring ? requested : clampStep(requested, checks);
  const faceView = useFaceInView(
    gate.stream,
    step === 'camera' && cameraValid && !faceOk,
    faceAttempt,
  );
  useEffect(() => {
    if (faceView.phase === 'passed') setFaceOk(true);
  }, [faceView.phase]);
  const index = stepIndex(step);
  const label = SETUP_STEPS[index]!.label;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      micRef.current?.getTracks().forEach((track) => track.stop());
      micRef.current = null;
    };
  }, []);

  // Persist progress so a refresh resumes at the right step.
  useEffect(() => {
    saveSetupProgress(assignmentId, {
      step,
      consent,
      phone,
      identity,
      identityUnverified,
    });
  }, [assignmentId, step, consent, phone, identity, identityUnverified]);

  // Focus management and announcement on every step change.
  useEffect(() => {
    headingRef.current?.focus();
    setAnnounce(`Step ${index + 1} of ${SETUP_STEPS.length}: ${label}`);
    setError('');
  }, [index, label]);

  // Show already-granted permissions without asking again.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    void Promise.all([queryPermission('camera'), queryPermission('microphone')]).then(
      ([camera, microphone]) => {
        if (!mounted.current) return;
        setPermissions((current) => ({
          camera: current.camera === 'unknown' ? camera : current.camera,
          microphone: current.microphone === 'unknown' ? microphone : current.microphone,
        }));
      },
    );
  }, []);

  const acquireMic = useCallback(async (): Promise<MediaStream | null> => {
    setMicBusy(true);
    setMicError('');
    setMicSilent(false);
    setMicHeard(false);
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    setMicStream(null);
    try {
      const stream = await acquireBuiltInMicrophone();
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return null;
      }
      micRef.current = stream;
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener('ended', () => {
          if (micRef.current !== stream) return;
          micRef.current = null;
          setMicStream(null);
          setMicHeard(false);
          setMicError('The microphone was disconnected. Reconnect it and press Retry.');
        }),
      );
      setMicStream(stream);
      return stream;
    } catch (failure) {
      if (mounted.current)
        setMicError(failure instanceof Error ? failure.message : 'Microphone unavailable.');
      return null;
    } finally {
      if (mounted.current) setMicBusy(false);
    }
  }, []);

  // Restore hardware after a refresh that happened beyond the hardware steps.
  useEffect(() => {
    if (!restoring) return;
    let cancelled = false;
    void (async () => {
      const camera = await runGate();
      if (cancelled) return;
      const microphone = camera.state === 'ok' ? await acquireMic() : null;
      if (cancelled || !mounted.current) return;
      if (camera.state === 'ok' && microphone !== null) {
        setPermissions({ camera: 'granted', microphone: 'granted' });
        setMicHeard(true);
        setLightingOk(true);
      } else {
        setRequested('permissions');
        setRestoreNote(
          'Setup was interrupted by a page refresh and your camera or microphone could not be restored automatically. Please allow them again.',
        );
      }
      setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount.
  }, []);

  // Camera step: run the camera gate as soon as the step opens.
  useEffect(() => {
    if (step === 'camera' && gate.state.phase === 'idle') void runGate();
  }, [step, gate.state.phase, runGate]);

  // Microphone step: open the built-in microphone as soon as the step opens.
  useEffect(() => {
    if (step === 'microphone' && micStream === null && !micBusy && micError === '')
      void acquireMic();
  }, [step, micStream, micBusy, micError, acquireMic]);

  // "We can't hear you" after 5 s of silence.
  useEffect(() => {
    if (step !== 'microphone' || micStream === null || micHeard) return;
    setMicSilent(false);
    const timer = setTimeout(() => setMicSilent(true), MIC_SILENCE_MS);
    return () => clearTimeout(timer);
  }, [step, micStream, micHeard]);

  const phonePresence = usePhonePresence(
    attemptId ?? undefined,
    attemptId !== null && step === 'phone',
    examApi,
  );
  // Paired and heartbeats arriving: show "Paired ✓" briefly, then move on by itself.
  useEffect(() => {
    if (step !== 'phone' || phone || !phonePresence.connected || attemptId === null) return;
    setPhone(true);
    setAnnounce('iPhone paired.');
    void Promise.resolve()
      .then(() => examApi.patchEvents(attemptId, { event: 'iphone_paired' }))
      .catch(() => {});
  }, [step, phone, phonePresence.connected, attemptId, examApi]);
  useEffect(() => {
    if (step !== 'phone' || !phone) return;
    const timer = setTimeout(() => {
      if (mounted.current) setRequested((current) => (current === 'phone' ? 'identity' : current));
    }, PAIRED_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [step, phone]);

  async function allowPermissions(): Promise<void> {
    setPermissionBusy(true);
    try {
      const camera = await requestOne('camera');
      const microphone = await requestOne('microphone');
      if (mounted.current) {
        setPermissions({ camera, microphone });
        setAnnounce(
          camera === 'granted' && microphone === 'granted'
            ? 'Camera and microphone allowed.'
            : 'A permission was blocked. Follow the instructions shown.',
        );
      }
    } finally {
      if (mounted.current) setPermissionBusy(false);
    }
  }

  async function startRecording(): Promise<void> {
    if (attemptId === null || screenBusy) return;
    setScreenBusy(true);
    setScreenError('');
    try {
      await startScreenRecording(attemptId, examApi, { localOnly: !recordingUpload });
      setAnnounce('Screen recording is on.');
      void Promise.resolve()
        .then(() => examApi.patchEvents(attemptId, { event: 'recording_started' }))
        .catch(() => {});
    } catch (failure) {
      if (mounted.current)
        setScreenError(
          failure instanceof Error ? failure.message : 'Screen recording could not start.',
        );
    } finally {
      if (mounted.current) setScreenBusy(false);
    }
  }

  async function goNext(): Promise<void> {
    if (!canAdvance(step, checks) || busy) return;
    setError('');
    if (step === 'consent' && attemptId === null) {
      setBusy(true);
      try {
        setAttemptId(await ensureAttempt());
      } catch {
        if (mounted.current)
          setError('Setup could not be started. Check your connection and try again.');
        return;
      } finally {
        if (mounted.current) setBusy(false);
      }
    }
    setRequested(nextStep(step));
  }

  async function start(): Promise<void> {
    if (attemptId === null || busy) return;
    setBusy(true);
    setError('');
    try {
      stopTypingCapture.current?.();
    } catch {
      // The baseline is optional; never block starting the exam on it.
    }
    stopTypingCapture.current = null;
    const clone = (stream: MediaStream | null) =>
      stream !== null && typeof stream.clone === 'function' ? stream.clone() : stream;
    // Hand the verified streams to the exam page so nothing is requested again.
    holdSensorStreams({ camera: clone(gate.stream), microphone: clone(micStream) });
    try {
      await onBegin({
        attemptId,
        identityVerified: identity && !identityUnverified,
      });
    } catch {
      releaseSensorStreams();
      if (mounted.current)
        setError('The exam could not be started. Check your connection and try again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const allDone = SETUP_STEPS.every((s) => s.id === 'ready' || canAdvance(s.id, checks));
  const next = canAdvance(step, checks) && !busy && !restoring;

  return (
    <main className="panel setup-page" aria-labelledby="setup-heading">
      <header className="setup-header">
        <p className="setup-eyebrow">Before you begin · {title}</p>
        <nav aria-label="Setup progress">
          <ol className="setup-dots">
            {SETUP_STEPS.map((s, i) => (
              <li
                key={s.id}
                className={[
                  'setup-dot',
                  i === index ? 'setup-dot--current' : '',
                  i < index || canAdvance(s.id, checks) ? 'setup-dot--done' : '',
                ].join(' ')}
                {...(i === index ? { 'aria-current': 'step' as const } : {})}
              >
                <span className="sr-only">
                  {s.label}
                  {canAdvance(s.id, checks) ? ' (done)' : ''}
                </span>
              </li>
            ))}
          </ol>
        </nav>
        <p className="setup-count" aria-hidden="true">
          Step {index + 1} of {SETUP_STEPS.length}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
      </header>

      <section className="setup-body">
        <h2 id="setup-heading" ref={headingRef} tabIndex={-1}>
          {label}
        </h2>
        {restoring && <p role="status">Restoring your camera and microphone…</p>}
        {restoreNote && <p role="alert">{restoreNote}</p>}

        {step === 'consent' && (
          <>
            <ConsentList recordingUpload={recordingUpload} />
            <p className="setup-strong">{NO_PAUSE_STATEMENT}</p>
            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>I understand and agree to these monitoring conditions for this exam.</span>
            </label>
          </>
        )}

        {step === 'permissions' && (
          <>
            <p>
              The exam needs your camera and microphone. Your browser will ask once; choose Allow.
            </p>
            <button
              type="button"
              className="topbar-submit"
              disabled={permissionBusy}
              onClick={() => void allowPermissions()}
            >
              {permissionBusy ? 'Waiting for your answer…' : 'Allow camera & microphone'}
            </button>
            <ul className="setup-permissions" aria-label="Permission status">
              {(['camera', 'microphone'] as const).map((kind) => (
                <li key={kind}>
                  <strong>{kind === 'camera' ? 'Camera' : 'Microphone'}:</strong>{' '}
                  {permissions[kind] === 'granted'
                    ? 'Allowed ✓'
                    : permissions[kind] === 'denied'
                      ? 'Blocked ✗'
                      : 'Not allowed yet'}
                  {permissions[kind] === 'denied' && (
                    <div role="alert" className="setup-fix">
                      <p>This is blocked. To fix it:</p>
                      <ol>
                        {permissionFixSteps(kind, userAgent()).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ol>
                      <button
                        type="button"
                        className="exam-control"
                        onClick={() => void allowPermissions()}
                      >
                        Check again
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 'camera' && (
          <>
            <p>
              We check that you are using a real built-in or USB webcam with a live picture. Virtual
              cameras such as OBS are not accepted.
            </p>
            <CameraGatePanel
              state={gate.state}
              cameras={gate.cameras}
              stream={gate.stream}
              onCheck={(id) => void runGate(id)}
            />
            {gate.state.phase === 'ok' && attestation === 'virtual' && (
              <div role="alert" className="setup-fix">
                <p>
                  This app reports the selected camera as a virtual camera, which is not allowed.
                  Choose your built-in or a USB webcam, or close the virtual-camera software and
                  check again.
                </p>
                <button type="button" className="exam-control" onClick={() => void runGate()}>
                  Check again
                </button>
              </div>
            )}
            {cameraValid && (
              <div className="setup-face" aria-live="polite">
                {faceOk ? (
                  <p role="status" className="setup-ok">
                    Face detected ✓
                  </p>
                ) : faceView.phase === 'unavailable' ? (
                  <div role="alert" className="setup-fix">
                    <p>{faceView.message}</p>
                    <button
                      type="button"
                      className="exam-control"
                      onClick={() => setFaceAttempt((count) => count + 1)}
                    >
                      Try again
                    </button>
                  </div>
                ) : faceView.phase === 'watching' && faceView.verdict === 'multiple' ? (
                  <p role="status">Only you should be in view. Ask anyone else to step away.</p>
                ) : faceView.phase === 'watching' ? (
                  <>
                    <p role="status">We can&apos;t see your face — sit in front of the camera.</p>
                    {faceView.dark && (
                      <ul className="setup-tips" aria-label="Lighting tips">
                        {LIGHTING_TIPS.too_dark.map((tip) => (
                          <li key={tip}>{tip}</li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p role="status">Looking for your face…</p>
                )}
              </div>
            )}
          </>
        )}

        {step === 'lighting' && (
          <>
            {lightingOk ? (
              <p role="status" className="setup-ok">
                Lighting check done ✓
              </p>
            ) : gate.stream !== null ? (
              <LightingCheckPanel stream={gate.stream} onResult={() => setLightingOk(true)} />
            ) : (
              <p role="status">Waiting for the camera…</p>
            )}
          </>
        )}

        {step === 'microphone' && (
          <>
            <p>Say a few words. The bar moves when we can hear the built-in microphone.</p>
            {micStream !== null && (
              <MicrophoneMeter stream={micStream} onHeard={() => setMicHeard(true)} />
            )}
            <p role="status" aria-live="polite">
              {micHeard
                ? 'We can hear you ✓'
                : micError !== ''
                  ? ''
                  : micSilent
                    ? 'We can’t hear you — check that the microphone is not muted and the input volume is up.'
                    : 'Listening…'}
            </p>
            {micError !== '' && <p role="alert">{micError}</p>}
            {(micSilent || micError !== '') && !micHeard && (
              <button
                type="button"
                className="exam-control"
                disabled={micBusy}
                onClick={() => void acquireMic()}
              >
                Retry
              </button>
            )}
          </>
        )}

        {step === 'screen' && attemptId !== null && (
          <>
            <p>
              Your entire screen is recorded for the whole exam, together with the built-in
              microphone. Recording starts here and runs until you submit; you cannot pause it.
            </p>
            {!recordingUpload && <p>{recordingStorageStatement(false)}</p>}
            {desktopAppsBridge() !== undefined ? (
              <p>
                The app records your main screen automatically. If macOS asks, allow Screen
                Recording for this app.
              </p>
            ) : (
              <ol className="setup-tips" aria-label="How to share your screen">
                <li>Press Start screen recording.</li>
                <li>
                  In the dialog, open the <strong>Entire screen</strong> tab (or
                  &ldquo;Screen&rdquo;) and pick your screen.
                </li>
                <li>Press Share. A window or a browser tab is not accepted.</li>
              </ol>
            )}
            {screenRunning ? (
              <p role="status" className="setup-ok">
                Screen recording is on ✓
              </p>
            ) : (
              <button
                type="button"
                className="topbar-submit"
                disabled={screenBusy}
                onClick={() => void startRecording()}
              >
                {screenBusy ? 'Waiting for your screen…' : 'Start screen recording'}
              </button>
            )}
            {screenRunning && recording.status !== '' && (
              <p className="muted">{recording.status}</p>
            )}
            {!screenRunning && (screenError !== '' || recording.error !== '') && (
              <div role="alert" className="setup-fix">
                <p>{screenError || recording.error}</p>
                <details>
                  <summary>Screen sharing blocked? How to allow it</summary>
                  <ol>
                    {permissionFixSteps('screen', userAgent()).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </details>
              </div>
            )}
          </>
        )}

        {step === 'phone' && attemptId !== null && (
          <>
            <p>
              Your iPhone confirms you stay at your desk. It sends only a presence signal; no camera
              or microphone is used on the phone.
            </p>
            <p role="status" aria-live="polite" className={phone ? 'setup-ok' : undefined}>
              {phone
                ? 'Paired ✓ — keep Exam Companion open with the phone face-down on the desk.'
                : pairingShown
                  ? 'Waiting for your iPhone…'
                  : 'Show the QR code, then scan it with Exam Companion.'}
            </p>
            {!phone && (
              <div className="setup-phone">
                <PhonePairingPanel
                  attemptId={attemptId}
                  api={examApi}
                  heading="Pair your iPhone"
                  onPairingCreated={() => setPairingShown(true)}
                />
              </div>
            )}
          </>
        )}

        {step === 'identity' && attemptId !== null && (
          <>
            {identity ? (
              <p role="status" className="setup-ok">
                Verified ✓
              </p>
            ) : (
              <>
                <p>
                  A quick check that you are here. If one method does not work for you, pick another
                  below it.
                </p>
                <LivenessModal
                  inline
                  attemptId={attemptId}
                  examApi={examApi}
                  onFailedAttempt={() => setIdentityFailures((count) => count + 1)}
                  onComplete={(success) => {
                    if (success) setIdentity(true);
                  }}
                />
                {identityFailures >= IDENTITY_MAX_FAILURES && (
                  <div className="setup-fix" role="status">
                    <p>
                      We could not complete the presence check. You can still continue; this is not
                      a problem on your side and will not stop you taking the exam.
                    </p>
                    <button
                      type="button"
                      className="topbar-submit"
                      onClick={() => {
                        setIdentityUnverified(true);
                        setIdentity(true);
                        void Promise.resolve()
                          .then(() =>
                            examApi.patchEvents(attemptId, { event: 'liveness_unverified' }),
                          )
                          .catch(() => {});
                      }}
                    >
                      Continue — your instructor will review this
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {step === 'ready' && (
          <>
            <ul className="setup-summary" aria-label="Setup summary">
              <li>Consent given ✓</li>
              <li>Camera ✓{gate.state.phase === 'ok' ? ` (${gate.state.label})` : ''}</li>
              <li>Microphone ✓</li>
              <li>{screenRunning ? 'Screen recording ✓' : 'Screen recording — not running'}</li>
              <li>iPhone paired ✓</li>
              <li>
                {identityUnverified
                  ? 'Presence check — your instructor will review this'
                  : 'Presence verified ✓'}
              </li>
            </ul>
            <p className="setup-strong">
              The exam timer starts when you press Start exam. {NO_PAUSE_STATEMENT}
            </p>
            <button
              type="button"
              className="topbar-submit setup-start"
              disabled={!allDone || busy}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start exam'}
            </button>
          </>
        )}

        {error !== '' && <p role="alert">{error}</p>}
      </section>

      <footer className="setup-nav">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            releaseSensorStreams();
            stopScreenRecording();
            onCancel();
          }}
        >
          Leave setup
        </button>
        <span className="setup-nav-spacer" />
        <button
          type="button"
          className="secondary-button"
          disabled={index === 0 || busy}
          onClick={() => setRequested(previousStep(step))}
        >
          Back
        </button>
        {step !== 'ready' && (
          <button
            type="button"
            className="topbar-submit"
            disabled={!next}
            onClick={() => void goNext()}
          >
            Next
          </button>
        )}
      </footer>
    </main>
  );
}
