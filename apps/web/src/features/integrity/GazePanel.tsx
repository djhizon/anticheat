import { useCallback, useEffect, useState } from 'react';
import type { EyeGazeSnapshot, EyeGazeTracker } from './eyeGazeTracker.js';
import { GazeCalibration } from './GazeCalibration.js';
import { GazeDial } from './GazeDial.js';
import { GazeStats } from './GazeStatsView.js';
import type { CalibrationFit } from './gazeEstimator.js';
import './gaze.css';

/** React refresh rate for the live gaze figure and statistics (about twice a second). */
export const GAZE_REFRESH_MS = 500;

const CALIBRATION_LABEL = {
  none: 'not calibrated (camera-centre estimate)',
  centre: 'centre only',
  'five-point': '5-point',
} as const;

/**
 * Compact, collapsible "Gaze details": dial + statistics + optional calibration. It only polls
 * the tracker while open, so the closed state costs nothing. Reusable by the instructor live
 * view: pass any tracker that is being fed samples.
 */
export function GazePanel({
  tracker,
  live,
  defaultOpen = false,
}: {
  readonly tracker: EyeGazeTracker;
  readonly live: boolean;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<EyeGazeSnapshot>(() => tracker.snapshot());
  const [calibrating, setCalibrating] = useState(false);
  const [message, setMessage] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setView(tracker.snapshot());
    if (!open || !live) return;
    const timer = setInterval(() => setView(tracker.snapshot()), GAZE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [tracker, open, live]);

  const done = useCallback(
    (fit: CalibrationFit | null) => {
      setCalibrating(false);
      setView(tracker.snapshot());
      setMessage(
        fit === null
          ? 'Calibration skipped or no clear face was seen. Estimates stay uncalibrated.'
          : fit.warnings.length > 0
            ? `Calibrated (${CALIBRATION_LABEL[fit.calibration.kind]}). ${fit.warnings.join(' ')}`
            : `Calibrated (${CALIBRATION_LABEL[fit.calibration.kind]}).`,
      );
    },
    [tracker],
  );

  const uncalibrated = view.calibration.kind === 'none';
  return (
    <>
      {live && uncalibrated && !dismissed && !calibrating && (
        <div className="gaze-calibrate-prompt" role="note">
          <span>Optional: a 10-second gaze calibration makes the estimate more accurate.</span>
          <button type="button" onClick={() => setCalibrating(true)}>
            Calibrate gaze (5 points)
          </button>
          <button
            type="button"
            onClick={() => done(tracker.calibrateCentreNow())}
            title="Look at the middle of the screen, then press"
          >
            Centre only
          </button>
          <button type="button" onClick={() => setDismissed(true)}>
            Not now
          </button>
        </div>
      )}
      {calibrating && <GazeCalibration tracker={tracker} onDone={done} />}
      <details
        className="gaze-panel"
        open={open}
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Gaze details</summary>
        {open && (
          <>
            <p className="muted">
              Estimated from head pose and iris position, on this device only. Accuracy is roughly
              ±5–10° and drops with glasses, glare or low light. It is context for a human reviewer,
              not proof of anything.
            </p>
            <div className="gaze-body">
              <GazeDial
                sample={live ? view.sample : null}
                trail={view.trail}
                sectorMs={view.stats.sectorMs}
              />
              <GazeStats stats={view.stats} />
            </div>
            <p className="muted">Calibration: {CALIBRATION_LABEL[view.calibration.kind]}</p>
            {message && <p role="status">{message}</p>}
            {live && (
              <button type="button" onClick={() => setCalibrating(true)}>
                {uncalibrated ? 'Calibrate gaze (5 points)' : 'Recalibrate gaze'}
              </button>
            )}
          </>
        )}
      </details>
    </>
  );
}
