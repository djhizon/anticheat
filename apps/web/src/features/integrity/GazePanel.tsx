import { useEffect, useState } from 'react';
import type { EyeGazeSnapshot, EyeGazeTracker } from './eyeGazeTracker.js';
import { GazeDial } from './GazeDial.js';
import { GazeStats } from './GazeStatsView.js';
import type { AutoCalibrationState } from './implicitCalibration.js';
import './gaze.css';

/** React refresh rate for the live gaze figure and statistics (about twice a second). */
export const GAZE_REFRESH_MS = 500;
/** The one-line calibration status refreshes slowly even while the details are closed. */
export const CALIBRATION_STATUS_MS = 2000;

/**
 * Debug builds can show the calibration status in the student panel with VITE_GAZE_DEBUG=1.
 * Production student views never show it: calibration is silent.
 */
export function gazeDebugEnabled(): boolean {
  return import.meta.env.DEV && import.meta.env.VITE_GAZE_DEBUG === '1';
}

/** Plain-language implicit-calibration status, for instructor and debug views only. */
export function calibrationStatusText(state: AutoCalibrationState): string {
  const percent = `${Math.round(state.confidence * 100)}%`;
  const base =
    state.phase === 'calibrated'
      ? `Calibrated (confidence ${percent})`
      : `Auto-calibrating… (learns as you work, confidence ${percent})`;
  return state.headOnly ? `${base} · eyes unclear, using head direction` : base;
}

/**
 * Compact, collapsible "Gaze details": dial and statistics. Calibration is implicit and silent
 * (learned from clicks and typing): students never see a prompt, button, status or confidence.
 * `showCalibration` adds the calibration status for instructor and debug views only. The
 * details only poll the tracker while open. Reusable by the instructor live view: pass any
 * tracker that is being fed samples.
 */
export function GazePanel({
  tracker,
  live,
  defaultOpen = false,
  showCalibration = false,
}: {
  readonly tracker: EyeGazeTracker;
  readonly live: boolean;
  readonly defaultOpen?: boolean;
  /** Instructor/debug only. Never set this in the student exam view. */
  readonly showCalibration?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<EyeGazeSnapshot>(() => tracker.snapshot());
  const [status, setStatus] = useState<AutoCalibrationState>(() => tracker.calibrationState());

  useEffect(() => {
    setView(tracker.snapshot());
    if (!open || !live) return;
    const timer = setInterval(() => setView(tracker.snapshot()), GAZE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [tracker, open, live]);

  useEffect(() => {
    setStatus(tracker.calibrationState());
    if (!live || !showCalibration) return;
    const timer = setInterval(() => setStatus(tracker.calibrationState()), CALIBRATION_STATUS_MS);
    return () => clearInterval(timer);
  }, [tracker, live, showCalibration]);

  const current = open && live ? view.auto : status;
  return (
    <details
      className="gaze-panel"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        Gaze details
        {live && showCalibration && (
          <span className="gaze-calibration-status" role="status">
            {' · '}
            {calibrationStatusText(current)}
          </span>
        )}
      </summary>
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
        </>
      )}
    </details>
  );
}
