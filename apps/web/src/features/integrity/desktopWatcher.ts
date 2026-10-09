export interface AppSnapshot {
  readonly attemptId: string;
  readonly foregroundApp: string;
  readonly displayCount: number;
  /** Labels of displays that look like capture cards or mirroring hardware. */
  readonly captureDisplays?: readonly string[];
  /** Run mode of the desktop shell; Demo disables the environment checks. */
  readonly runMode?: 'demo' | 'strict';
}

export interface DesktopWatcherBridge {
  startWatcher(attemptId: string): void;
  stopWatcher(): void;
  onAppSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  /** Exam-window lockdown events (blocked minimize, left fullscreen, focus lost, emergency exit). */
  onLockdownEvent?(callback: (event: { attemptId: string; event: string }) => void): () => void;
}

const LOCKDOWN_EVENTS = new Set([
  'window_minimize_blocked',
  'fullscreen_exit_blocked',
  'focus_lost',
  'lockdown_emergency_exit',
  'brightness_restored',
]);

// The lockdown shell itself (and the dev-mode Electron binary) is expected focus.
const OWN_APPS = new Set(['Exam Anti-Cheat', 'Electron']);

export function desktopWatcherBridge(): DesktopWatcherBridge | undefined {
  const bridge = (window as Window & { electronExam?: Partial<DesktopWatcherBridge> }).electronExam;
  return bridge?.startWatcher && bridge.stopWatcher && bridge.onAppSnapshot
    ? (bridge as DesktopWatcherBridge)
    : undefined;
}

/**
 * Forward the Electron foreground-app / display-count watcher to the API.
 * Only changes are sent, and only when another app has focus or an extra
 * display appears, so a quiet exam produces no traffic.
 */
export function startDesktopWatcher(
  bridge: DesktopWatcherBridge,
  attemptId: string,
  send: (event: Record<string, unknown>) => Promise<unknown>,
): () => void {
  let last = '';
  const reportedCapture = new Set<string>();
  let reportedDemo = false;
  const unsubscribe = bridge.onAppSnapshot((snapshot) => {
    if (snapshot.attemptId !== attemptId) return;
    // Record that this attempt ran in Demo mode (shown in the transparency report).
    if (snapshot.runMode === 'demo' && !reportedDemo) {
      reportedDemo = true;
      send({ event: 'desktop_demo_mode' }).catch(() => {
        reportedDemo = false; // Retry on the next snapshot.
      });
    }
    for (const label of snapshot.captureDisplays ?? []) {
      if (reportedCapture.has(label)) continue;
      reportedCapture.add(label);
      send({ event: 'capture_display_connected' }).catch(() => {});
    }
    // Another app in front is an evidence trigger once it is reported repeatedly (the
    // capture hook applies the 2 s hold). Demo mode disables environment checks.
    if (
      typeof window !== 'undefined' &&
      snapshot.runMode !== 'demo' &&
      snapshot.foregroundApp !== 'unknown' &&
      !OWN_APPS.has(snapshot.foregroundApp)
    ) {
      window.dispatchEvent(
        new CustomEvent('evidence-trigger', { detail: { trigger: 'disallowed_app_foreground' } }),
      );
    }
    const suspicious = snapshot.displayCount > 1 || !OWN_APPS.has(snapshot.foregroundApp);
    const key = `${snapshot.foregroundApp}|${snapshot.displayCount}`;
    if (key === last) return;
    last = key;
    if (!suspicious || snapshot.foregroundApp === 'unknown') return;
    send({ foregroundApp: snapshot.foregroundApp, displayCount: snapshot.displayCount }).catch(
      () => {},
    );
  });
  const unsubscribeLockdown = bridge.onLockdownEvent?.((payload) => {
    if (payload.attemptId !== attemptId || !LOCKDOWN_EVENTS.has(payload.event)) return;
    send({ event: payload.event }).catch(() => {});
  });
  bridge.startWatcher(attemptId);
  return () => {
    unsubscribe();
    unsubscribeLockdown?.();
    bridge.stopWatcher();
  };
}
