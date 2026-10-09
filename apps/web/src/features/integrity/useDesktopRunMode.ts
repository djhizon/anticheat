import { useEffect, useState } from 'react';
import { desktopAppsBridge, readDesktopRunMode, type DesktopRunMode } from './desktopApps.js';

/** Null outside Electron or until the main process has answered. */
export function useDesktopRunMode(): DesktopRunMode | null {
  const [mode, setMode] = useState<DesktopRunMode | null>(null);
  useEffect(() => {
    const bridge = desktopAppsBridge();
    if (!bridge) return;
    let live = true;
    void readDesktopRunMode(bridge).then((value) => {
      if (live) setMode(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return mode;
}
