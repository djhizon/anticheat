export interface AppSnapshot {
  readonly attemptId: string;
  readonly foregroundApp: string;
  readonly displayCount: number;
  /** Labels of displays that look like capture cards or mirroring hardware. */
  readonly captureDisplays?: readonly string[];
}

export interface DesktopWatcherBridge {
  startWatcher(attemptId: string): void;
  stopWatcher(): void;
  onAppSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
}

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
  const unsubscribe = bridge.onAppSnapshot((snapshot) => {
    if (snapshot.attemptId !== attemptId) return;
    for (const label of snapshot.captureDisplays ?? []) {
      if (reportedCapture.has(label)) continue;
      reportedCapture.add(label);
      send({ event: 'capture_display_connected' }).catch(() => {});
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
  bridge.startWatcher(attemptId);
  return () => {
    unsubscribe();
    bridge.stopWatcher();
  };
}
