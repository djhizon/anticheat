import { desktopAppsBridge } from './desktopApps.js';
import { useDesktopRunMode } from './useDesktopRunMode.js';
import { useReservedSpace } from './useReservedSpace.js';

/** Deliberately persistent while the demo-mode-only native exemptions are enabled. */
export function DevelopmentExemptions(): React.ReactElement | null {
  const mode = useDesktopRunMode();
  const shown = typeof desktopAppsBridge()?.listAppTargets === 'function' && mode === 'demo';
  const ref = useReservedSpace<HTMLElement>('--demo-bottom-offset', shown);
  if (!shown) return null;
  return (
    <aside ref={ref} role="note" className="demo-exemptions-strip">
      Demo mode: Terminal and ChatGPT are exempt from the app check. Strict mode has no exemptions.
      Keep the local server terminal running.
    </aside>
  );
}
