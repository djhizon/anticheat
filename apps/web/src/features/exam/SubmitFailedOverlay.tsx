import { useEffect, useRef } from 'react';

/**
 * Blocking overlay after a submit request failed (network or server error). The screen
 * recording was finished for submit; the student retries or returns to answering, which
 * restarts the recording. Distinct from the "recording stopped" overlay, which is only for
 * genuine recording stops.
 */
export function SubmitFailedOverlay({
  busy,
  message,
  onRetry,
  onContinue,
}: {
  readonly busy: boolean;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onContinue: () => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <div className="exam-pause-overlay" role="alertdialog" aria-label="Submit failed">
      <div className="pause-card">
        <h2>Submit failed</h2>
        <p role="alert">{message}</p>
        <p className="muted">
          Check your connection and try again. The exam clock keeps running; nothing you saved is
          lost.
        </p>
        <button
          ref={button}
          type="button"
          className="topbar-submit"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? 'Submitting…' : 'Retry submit'}
        </button>
        <button
          type="button"
          className="exam-control exam-control--secondary"
          disabled={busy}
          onClick={onContinue}
        >
          Keep answering
        </button>
      </div>
    </div>
  );
}
