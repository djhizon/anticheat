import { useEffect, useState } from 'react';
import {
  demoExemptionText,
  desktopAppsBridge,
  readDemoInfo,
  type DesktopDemoInfo,
} from './desktopApps.js';
import { useDesktopRunMode } from './useDesktopRunMode.js';
import { useReservedSpace } from './useReservedSpace.js';

/** Deliberately persistent while the demo-mode-only native exemptions are enabled. */
export function DevelopmentExemptions(): React.ReactElement | null {
  const mode = useDesktopRunMode();
  const shown = typeof desktopAppsBridge()?.listAppTargets === 'function' && mode === 'demo';
  const ref = useReservedSpace<HTMLElement>('--demo-bottom-offset', shown);
  const [info, setInfo] = useState<DesktopDemoInfo | null>(null);
  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    void readDemoInfo().then((value) => {
      if (live) setInfo(value);
    });
    return () => {
      live = false;
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <aside ref={ref} role="note" className="demo-exemptions-strip">
      {demoExemptionText(info)}
    </aside>
  );
}
