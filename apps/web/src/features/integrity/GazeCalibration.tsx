import { useEffect, useState } from 'react';
import type { EyeGazeTracker } from './eyeGazeTracker.js';
import {
  CALIBRATION_ORDER,
  type CalibrationFit,
  type CalibrationTarget,
  type RawGaze,
} from './gazeEstimator.js';

const SETTLE_MS = 500;
const CAPTURE_MS = 1200;
const POSITIONS: Record<CalibrationTarget, { left: string; top: string }> = {
  centre: { left: '50%', top: '50%' },
  topLeft: { left: '6%', top: '8%' },
  topRight: { left: '94%', top: '8%' },
  bottomRight: { left: '94%', top: '92%' },
  bottomLeft: { left: '6%', top: '92%' },
};
const LABEL: Record<CalibrationTarget, string> = {
  centre: 'the centre dot',
  topLeft: 'the top-left dot',
  topRight: 'the top-right dot',
  bottomRight: 'the bottom-right dot',
  bottomLeft: 'the bottom-left dot',
};

/**
 * Quick 5-point gaze calibration (centre + four corners, about 1.7 s each). Optional: Escape
 * skips it. Everything stays in memory on this device.
 */
export function GazeCalibration({
  tracker,
  onDone,
}: {
  readonly tracker: EyeGazeTracker;
  /** null = cancelled or no usable face; otherwise the applied fit. */
  readonly onDone: (fit: CalibrationFit | null) => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const collected: Partial<Record<CalibrationTarget, RawGaze[]>> = {};
    let step = 0;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let done = false;
    const finish = (fit: CalibrationFit | null) => {
      if (done) return;
      done = true;
      tracker.endCapture();
      onDone(fit);
    };
    const run = () => {
      if (done) return;
      const target = CALIBRATION_ORDER[step]!;
      setIndex(step);
      timers.push(
        setTimeout(() => {
          tracker.beginCapture();
          timers.push(
            setTimeout(() => {
              collected[target] = tracker.endCapture();
              step += 1;
              if (step >= CALIBRATION_ORDER.length) finish(tracker.applyFit(collected));
              else run();
            }, CAPTURE_MS),
          );
        }, SETTLE_MS),
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(null);
    };
    window.addEventListener('keydown', key);
    run();
    return () => {
      done = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', key);
      tracker.endCapture();
    };
  }, [tracker, onDone]);
  const target = CALIBRATION_ORDER[index]!;
  return (
    <div
      className="gaze-calibration-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Gaze calibration"
    >
      <div className="gaze-calibration-dot" style={POSITIONS[target]} />
      <p style={{ maxWidth: 420 }}>
        Look at {LABEL[target]} ({index + 1} of {CALIBRATION_ORDER.length}) and keep your head
        natural. Press Escape to skip. Nothing leaves this device.
      </p>
    </div>
  );
}
