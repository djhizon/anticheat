import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { desktopBrightnessBridge } from './desktopBrightness.js';
import { tuneCameraTrack } from './cameraTuning.js';
import { setLightBoost, useLightBoost } from './lightBoost.js';
import {
  analyseLighting,
  lightingImprovement,
  type LightingClass,
  type LightingReport,
} from './lightingAnalysis.js';
import { createStreamLightingSampler } from './lightingSampler.js';
import type { Box } from './gazeEstimator.js';

export interface LightingCheckResult {
  /** `good`: the lighting passed. `warning`: the student continued after 20 s of trying. */
  readonly outcome: 'good' | 'warning';
  readonly class: LightingClass | null;
  readonly faceMean: number | null;
  readonly boostUsed: boolean;
}

export interface LightingCheckPanelProps {
  /** The live camera stream from the camera step. The panel never stops or replaces it. */
  readonly stream: MediaStream;
  /** Called exactly once: when lighting is good, or when the student continues with a warning. */
  readonly onResult: (result: LightingCheckResult) => void;
  /** Optional MediaPipe face box (normalised 0..1); the picture centre is used when absent. */
  readonly getFaceBox?: () => Box | null;
  /** Lighting must never lock anyone out: Continue appears after this long (default 20 s). */
  readonly warnAfterMs?: number;
  readonly sampleIntervalMs?: number;
}

const GOOD_SAMPLES_NEEDED = 2;
const FLASH_SETTLE_MS = 900;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function LightingCheckPanel({
  stream,
  onResult,
  getFaceBox,
  warnAfterMs = 20_000,
  sampleIntervalMs = 1500,
}: LightingCheckPanelProps) {
  const [report, setReport] = useState<LightingReport | null>(null);
  const [canContinue, setCanContinue] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [measure, setMeasure] = useState<string | null>(null);
  const [tuning, setTuning] = useState<string | null>(null);
  const boost = useLightBoost();
  const samplerRef = useRef<ReturnType<typeof createStreamLightingSampler> | null>(null);
  const resolved = useRef(false);
  const boostUsed = useRef(false);
  const tuned = useRef(false);
  const goodRun = useRef(0);
  const latest = useRef<LightingReport | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const faceBoxRef = useRef(getFaceBox);
  faceBoxRef.current = getFaceBox;
  const flashingRef = useRef(false);

  const finish = useCallback((outcome: 'good' | 'warning') => {
    if (resolved.current) return;
    resolved.current = true;
    onResultRef.current({
      outcome,
      class: latest.current?.class ?? null,
      faceMean: latest.current ? Math.round(latest.current.metrics.faceMean) : null,
      boostUsed: boostUsed.current,
    });
  }, []);

  const takeReport = useCallback(async (): Promise<LightingReport | null> => {
    const sample = await samplerRef.current?.sample(3, 120);
    if (!sample) return null;
    return analyseLighting({
      frames: sample.frames,
      width: sample.width,
      height: sample.height,
      faceBox: faceBoxRef.current?.() ?? null,
    });
  }, []);

  useEffect(() => {
    const sampler = createStreamLightingSampler(stream);
    samplerRef.current = sampler;
    let live = true;
    const tick = async (): Promise<void> => {
      if (flashingRef.current) return;
      const next = await takeReport();
      if (!live || next === null || flashingRef.current) return;
      latest.current = next;
      setReport(next);
      goodRun.current = next.class === 'good' ? goodRun.current + 1 : 0;
      if (goodRun.current >= GOOD_SAMPLES_NEEDED) finish('good');
      if (!tuned.current && (next.class === 'dim' || next.class === 'too_dark')) {
        tuned.current = true;
        const result = await tuneCameraTrack(stream.getVideoTracks()[0], { dim: true });
        if (live)
          setTuning(
            result.supported
              ? `Camera brightness adjusted (${result.applied.join(', ')}).`
              : 'This camera does not allow brightness changes from the app.',
          );
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), sampleIntervalMs);
    const timer = setTimeout(() => {
      if (live) setCanContinue(true);
    }, warnAfterMs);
    return () => {
      live = false;
      clearInterval(interval);
      clearTimeout(timer);
      sampler.dispose();
      samplerRef.current = null;
      setLightBoost(false);
    };
  }, [stream, takeReport, finish, sampleIntervalMs, warnAfterMs]);

  const toggleBoost = (): void => {
    const next = !boost;
    if (next) boostUsed.current = true;
    setLightBoost(next);
    setMeasure(null);
    goodRun.current = 0;
  };

  /** Full-white flash: compare the face before and after the screen lights it up. */
  const measureScreenLight = async (): Promise<void> => {
    if (flashingRef.current) return;
    flashingRef.current = true;
    setMeasure('Measuring… hold still.');
    const wasBoost = boost;
    setLightBoost(false);
    try {
      await wait(250);
      const before = await takeReport();
      setFlashing(true);
      await wait(FLASH_SETTLE_MS);
      const after = await takeReport();
      setFlashing(false);
      if (before && after) {
        const gain = lightingImprovement(before, after);
        boostUsed.current = true;
        setMeasure(
          gain >= 5
            ? `Screen light made your face brighter (+${gain}). Turn on "Boost light" to keep it.`
            : 'Screen light barely changed your face. Move closer to the screen or use a lamp.',
        );
      } else {
        setMeasure('Could not measure the camera picture. Try again.');
      }
    } finally {
      setFlashing(false);
      flashingRef.current = false;
      setLightBoost(wasBoost);
    }
  };

  const good = report?.class === 'good';
  const desktop = desktopBrightnessBridge() !== undefined;
  return (
    <section className="lighting-check" aria-label="Lighting check">
      <h3>Lighting check</h3>
      <p role="status" aria-live="polite">
        {report === null ? 'Checking your lighting…' : report.headline}
      </p>
      {report !== null && (
        <p className="muted">
          Face brightness {Math.round(report.metrics.faceMean)} of 255
          {report.metrics.faceKnown ? '' : ' (measured from the middle of the picture)'}.
        </p>
      )}
      {report !== null && !good && report.tips.length > 0 && (
        <ul aria-label="How to improve your lighting">
          {report.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      )}
      <div className="cam-controls">
        <button type="button" aria-pressed={boost} onClick={toggleBoost}>
          Boost light
        </button>
        <button type="button" onClick={() => void measureScreenLight()} disabled={flashing}>
          Test screen light
        </button>
      </div>
      {measure !== null && <p role="status">{measure}</p>}
      {tuning !== null && <p className="muted">{tuning}</p>}
      <p className="muted">
        {desktop
          ? 'When the exam starts, this app raises your built-in screen to full brightness and puts it back afterwards.'
          : 'Browsers cannot change your screen brightness. Turn it up to maximum yourself for the best face tracking.'}
      </p>
      {canContinue && !good && (
        <div role="alert">
          <p>
            Your lighting is still not ideal. Face tracking may be less reliable, but you can
            continue. This is not a failure.
          </p>
          <button type="button" onClick={() => finish('warning')}>
            Continue with a lighting warning
          </button>
        </div>
      )}
      {flashing &&
        createPortal(
          <div
            data-testid="lighting-flash"
            role="presentation"
            style={{
              position: 'fixed',
              inset: 0,
              background: '#ffffff',
              color: '#111111',
              zIndex: 2147483600,
              display: 'grid',
              placeItems: 'center',
              fontSize: 20,
            }}
          >
            Measuring light… hold still.
          </div>,
          document.body,
        )}
    </section>
  );
}
