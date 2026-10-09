import { useEffect, useRef } from 'react';

/** Blocking overlay shown mid-exam while the mandatory screen recording is not running. */
export function ScreenRecordingPausedOverlay({
  busy,
  reason,
  error,
  onResume,
}: {
  readonly busy: boolean;
  /** Why recording stopped (share ended, page refreshed, …); may be empty. */
  readonly reason: string;
  readonly error: string;
  readonly onResume: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <div className="exam-pause-overlay" role="alertdialog" aria-label="Screen recording stopped">
      <div className="pause-card">
        <h2>Screen recording stopped — answering is paused</h2>
        <p>
          The exam records your entire screen until you submit. Your saved answers are kept and the
          exam clock keeps running. Resume the recording to continue.
        </p>
        {reason !== '' && <p className="muted">{reason}</p>}
        <p className="muted">
          In the dialog choose <strong>Entire screen</strong> and press Share; a window or a browser
          tab is not accepted.
        </p>
        {error !== '' && <p role="alert">{error}</p>}
        <button
          ref={button}
          type="button"
          className="topbar-submit"
          disabled={busy}
          onClick={onResume}
        >
          {busy ? 'Waiting for your screen…' : 'Resume screen recording'}
        </button>
      </div>
    </div>
  );
}
