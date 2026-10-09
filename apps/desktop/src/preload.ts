import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronExam', {
  startWatcher: (attemptId: string) => {
    if (typeof attemptId === 'string' && attemptId.length > 0 && attemptId.length <= 200)
      ipcRenderer.send('start-watcher', attemptId);
  },
  stopWatcher: () => ipcRenderer.send('stop-watcher'),
  getDisplayCount: () => ipcRenderer.invoke('get-display-count') as Promise<number>,
  getForegroundApp: () => ipcRenderer.invoke('get-foreground-app') as Promise<string>,
  getEnvironmentRisk: () =>
    ipcRenderer.invoke('get-environment-risk') as Promise<{
      virtualMachine: string | null;
      captureDisplays: string[];
    }>,
  captureScreenSnapshot: () =>
    ipcRenderer.invoke('capture-screen-snapshot') as Promise<string | null>,
  getDemoInfo: () =>
    ipcRenderer.invoke('get-demo-info') as Promise<{ exemptApps: string[]; packaged: boolean }>,
  startPhoneLan: () =>
    ipcRenderer.invoke('start-phone-lan') as Promise<{ origin: string | null; error?: string }>,
  openRecordingsFolder: () =>
    ipcRenderer.invoke('open-recordings-folder') as Promise<{
      opened: boolean;
      path?: string;
      error?: string;
    }>,
  getRunMode: () => ipcRenderer.invoke('get-run-mode') as Promise<'demo' | 'strict'>,
  listAppTargets: () => ipcRenderer.invoke('list-app-targets'),
  closeAppTarget: (id: string, mode: 'quit' | 'force') =>
    ipcRenderer.invoke('close-app-target', { id, mode }),
  boostBrightness: (attemptId: string) =>
    ipcRenderer.invoke('display:boost-brightness', attemptId) as Promise<unknown>,
  restoreBrightness: () => ipcRenderer.invoke('display:restore-brightness') as Promise<unknown>,
  getCameraAttestation: (label: string, options?: { refresh: boolean }) =>
    ipcRenderer.invoke(
      'camera-attestation',
      label,
      ...(options && typeof options.refresh === 'boolean' ? [{ refresh: options.refresh }] : []),
    ) as Promise<{
      verdict: 'hardware' | 'virtual' | 'unknown';
      kind: 'builtin' | 'usb' | 'continuity' | 'virtual' | 'unknown';
      reasons: string[];
      matchedDevice: {
        name: string;
        kind: 'builtin' | 'usb' | 'continuity' | 'virtual' | 'unknown';
        transportType: string;
        modelID: string;
        manufacturer: string;
      } | null;
    }>,
  reportRenderFailure: () => ipcRenderer.send('renderer-failure'),
  onAppSnapshot: (
    callback: (snapshot: {
      attemptId: string;
      foregroundApp: string;
      displayCount: number;
      captureDisplays?: string[];
      runMode?: 'demo' | 'strict';
    }) => void,
  ) => {
    const listener = (
      _event: unknown,
      snapshot: {
        attemptId: string;
        foregroundApp: string;
        displayCount: number;
        captureDisplays?: string[];
        runMode?: 'demo' | 'strict';
      },
    ) => callback(snapshot);
    ipcRenderer.on('app-snapshot', listener);
    return () => ipcRenderer.removeListener('app-snapshot', listener);
  },
  onLockdownEvent: (callback: (event: { attemptId: string; event: string }) => void) => {
    const listener = (_event: unknown, payload: { attemptId: string; event: string }) =>
      callback(payload);
    ipcRenderer.on('lockdown-event', listener);
    return () => ipcRenderer.removeListener('lockdown-event', listener);
  },
  onEmergencyExit: (callback: () => void) => ipcRenderer.on('emergency-exit', callback),
});

// Report only the failure category; never copy form values or exception text.
window.addEventListener('error', () => ipcRenderer.send('renderer-failure'));
window.addEventListener('unhandledrejection', () => ipcRenderer.send('renderer-failure'));
