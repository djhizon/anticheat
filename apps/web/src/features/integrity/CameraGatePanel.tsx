import { useCallback, useEffect, useRef, useState } from 'react';
import { checkCamera, type CameraBlock, type CameraGateResult } from './cameraGate.js';
import { setPreferredCameraId, type CameraChoices } from './physicalCamera.js';

export type CameraGateState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'ok'; readonly label: string; readonly deviceId: string }
  | { readonly phase: 'blocked'; readonly block: CameraBlock };

/**
 * Runs the camera gate and keeps the verified preview stream while the gate is
 * ok. The stream is stopped on re-run and unmount.
 */
export function useCameraGate(): {
  readonly state: CameraGateState;
  readonly cameras: CameraChoices;
  readonly stream: MediaStream | null;
  readonly run: (preferredId?: string) => Promise<CameraGateResult>;
  readonly reset: () => void;
} {
  const [state, setState] = useState<CameraGateState>({ phase: 'idle' });
  const [cameras, setCameras] = useState<CameraChoices>({ native: [], virtual: [] });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const runId = useRef(0);

  const release = useCallback(() => {
    current.current?.getTracks().forEach((track) => track.stop());
    current.current = null;
    setStream(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.getTracks().forEach((track) => track.stop());
      current.current = null;
    };
  }, []);

  const run = useCallback(
    async (preferredId?: string): Promise<CameraGateResult> => {
      const id = ++runId.current;
      release();
      setState({ phase: 'checking' });
      const result = await checkCamera(preferredId !== undefined ? { preferredId } : {});
      if (!mounted.current || id !== runId.current) {
        if (result.state === 'ok') result.stream.getTracks().forEach((track) => track.stop());
        return result;
      }
      setCameras(result.cameras);
      if (result.state === 'ok') {
        current.current = result.stream;
        setStream(result.stream);
        setPreferredCameraId(result.deviceId || null);
        setState({ phase: 'ok', label: result.label, deviceId: result.deviceId });
      } else setState({ phase: 'blocked', block: result });
      return result;
    },
    [release],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    release();
    setState({ phase: 'idle' });
  }, [release]);

  return { state, cameras, stream, run, reset };
}

/** Step-by-step instructions for a blocked camera. */
export function CameraBlockedNotice({
  block,
  checking,
  onRetry,
}: {
  readonly block: CameraBlock;
  readonly checking: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div role="alert" className="camera-gate-blocked">
      <h3>{block.title}</h3>
      <p>The exam needs a real built-in or USB webcam. Please fix this:</p>
      <ol>
        {block.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <button type="button" className="exam-control" disabled={checking} onClick={onRetry}>
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}

/** Gate UI for the consent step: status, live preview, native-only picker, blocked help. */
export function CameraGatePanel({
  state,
  cameras,
  stream,
  onCheck,
}: {
  readonly state: CameraGateState;
  readonly cameras: CameraChoices;
  readonly stream: MediaStream | null;
  readonly onCheck: (preferredId?: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {});
  }, [stream]);
  if (state.phase === 'idle') return null;
  const selectedId = state.phase === 'ok' ? state.deviceId : '';
  return (
    <section className="camera-gate" aria-label="Camera check">
      {state.phase === 'checking' && <p role="status">Camera check: checking your webcam…</p>}
      {state.phase === 'ok' && (
        <p role="status">
          Camera check passed. Using: <strong>{state.label}</strong>
        </p>
      )}
      {state.phase === 'blocked' && (
        <CameraBlockedNotice block={state.block} checking={false} onRetry={() => onCheck()} />
      )}
      <video
        ref={video}
        muted
        playsInline
        aria-label="Camera check preview"
        style={{ display: stream ? 'block' : 'none', width: 160, borderRadius: 6 }}
      />
      {(cameras.native.length > 1 || cameras.virtual.length > 0) && (
        <fieldset disabled={state.phase === 'checking'}>
          <legend>Cameras</legend>
          {cameras.native.map((camera) => (
            <label key={camera.deviceId} style={{ display: 'block' }}>
              <input
                type="radio"
                name="exam-camera"
                checked={selectedId === camera.deviceId}
                onChange={() => onCheck(camera.deviceId)}
              />{' '}
              {camera.label}
            </label>
          ))}
          {cameras.virtual.map((camera) => (
            <label key={camera.deviceId} style={{ display: 'block', opacity: 0.5 }}>
              <input type="radio" name="exam-camera" disabled /> {camera.label} (virtual — not
              allowed)
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}

/** Blocking overlay shown mid-exam while the native webcam feed is lost. */
export function CameraLostOverlay({
  checking,
  block,
  onRetry,
}: {
  readonly checking: boolean;
  readonly block: CameraBlock | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="exam-pause-overlay" role="alertdialog" aria-label="Camera feed lost">
      <div className="pause-card">
        <h2>Camera feed lost — reconnect your built-in webcam</h2>
        <p>
          Answering is paused and the questions are hidden. Your saved answers are kept and the exam
          clock keeps running. The exam resumes by itself once a real webcam is working.
        </p>
        {block ? (
          <CameraBlockedNotice block={block} checking={checking} onRetry={onRetry} />
        ) : (
          <>
            <p role="status">{checking ? 'Checking your webcam…' : 'Waiting for your webcam…'}</p>
            <button type="button" className="exam-control" disabled={checking} onClick={onRetry}>
              Check again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
