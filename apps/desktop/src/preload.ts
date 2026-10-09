import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronExam', {
  startWatcher: (attemptId: string) => ipcRenderer.send('start-watcher', attemptId),
  stopWatcher: () => ipcRenderer.send('stop-watcher'),
  getDisplayCount: () => ipcRenderer.invoke('get-display-count') as Promise<number>,
  getForegroundApp: () => ipcRenderer.invoke('get-foreground-app') as Promise<string>,
  listAppTargets: () => ipcRenderer.invoke('list-app-targets'),
  closeAppTarget: (id: string, mode: 'quit' | 'force') => ipcRenderer.invoke('close-app-target', { id, mode }),
  reportRenderFailure: () => ipcRenderer.send('renderer-failure'),
  onAppSnapshot: (
    callback: (snapshot: { attemptId: string; foregroundApp: string; displayCount: number }) => void,
  ) => {
    const listener = (_event: unknown, snapshot: { attemptId: string; foregroundApp: string; displayCount: number }) =>
      callback(snapshot);
    ipcRenderer.on('app-snapshot', listener);
    return () => ipcRenderer.removeListener('app-snapshot', listener);
  },
  onEmergencyExit: (callback: () => void) =>
    ipcRenderer.on('emergency-exit', callback),
});

// Report only the failure category; never copy form values or exception text.
window.addEventListener('error', () => ipcRenderer.send('renderer-failure'));
window.addEventListener('unhandledrejection', () => ipcRenderer.send('renderer-failure'));
