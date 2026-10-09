import { desktopAppsBridge } from './desktopApps.js';

/**
 * What the Mac app knows about the last refused screen capture. The page itself only sees a
 * DOMException from getDisplayMedia: since Electron 44 a refused request surfaces as the opaque
 * "Invalid capture constraints", so the setup step asks the app for the real reason.
 */
export interface ScreenCaptureDiagnosis {
  /** macOS Screen Recording status: granted, denied, restricted, not-determined or unknown. */
  readonly permission: string;
  /** Fixed refusal code from the app's display-media handler, null if it granted. */
  readonly lastRefusal: string | null;
}

/** Exact recovery for the ad-hoc signed Mac app: a rebuild invalidates the earlier grant. */
export const MAC_SCREEN_RECORDING_RESET_STEPS: readonly string[] = [
  'Quit ExamGuard completely (ExamGuard → Quit, or Cmd+Q).',
  'Open System Settings → Privacy & Security → Screen & System Audio Recording.',
  'Remove ExamGuard from the list with “–”, then add /Applications/ExamGuard.app again with “+” and turn it on. (Terminal alternative: tccutil reset ScreenCapture com.examguard.desktop, then turn it on when macOS asks.)',
  'Reopen ExamGuard, sign in and press Start screen recording again.',
];

export const MAC_SCREEN_RECORDING_BLOCKED =
  'macOS is not letting this app record the screen (an earlier grant no longer matches this build, or it was never allowed). Follow the steps below, then try again.';

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? String((error as { name?: unknown }).name ?? '')
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * Maps a failed desktop getDisplayMedia call to a student-facing message, using the app's
 * diagnosis when available. Returns null when the error is not a recognised capture refusal
 * (the caller keeps its own message).
 */
export function describeDesktopCaptureFailure(
  error: unknown,
  diagnosis: ScreenCaptureDiagnosis | null,
): string | null {
  const name = errorName(error);
  const message = errorMessage(error);
  const refusal = diagnosis?.lastRefusal ?? null;
  if (refusal === 'gesture' || refusal === 'busy' || name === 'InvalidStateError')
    return 'Click Start screen recording again with the exam window focused.';
  if (refusal === 'cancelled')
    return 'Screen recording was cancelled. Press Start screen recording and choose a screen.';
  if (name === 'NotSupportedError')
    return 'Screen capture is not configured in this desktop build. Quit it and launch the rebuilt recording-fix app.';
  const permissionProblem =
    diagnosis !== null && diagnosis.permission !== 'granted' && diagnosis.permission !== 'unknown';
  const capturePathFailure =
    refusal === 'permission' || refusal === 'no-sources' || refusal === 'sources-failed';
  const chromiumRefusal =
    name === 'NotAllowedError' ||
    name === 'NotReadableError' ||
    name === 'AbortError' ||
    /invalid capture constraints/iu.test(message) ||
    /permission denied/iu.test(message) ||
    /error starting (screen )?capture/iu.test(message) ||
    /could not start video source/iu.test(message);
  if (permissionProblem || capturePathFailure || chromiumRefusal)
    return MAC_SCREEN_RECORDING_BLOCKED;
  return null;
}

/** Asks the Mac app why the last capture was refused; null outside the app or on any error. */
export async function readScreenCaptureDiagnosis(): Promise<ScreenCaptureDiagnosis | null> {
  const bridge = desktopAppsBridge();
  if (typeof bridge?.getScreenCaptureDiagnosis !== 'function') return null;
  try {
    const value = (await bridge.getScreenCaptureDiagnosis()) as Partial<ScreenCaptureDiagnosis>;
    if (typeof value?.permission !== 'string') return null;
    return {
      permission: value.permission,
      lastRefusal: typeof value.lastRefusal === 'string' ? value.lastRefusal : null,
    };
  } catch {
    return null;
  }
}
