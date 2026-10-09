import { desktopAppsBridge } from './desktopApps.js';
import { useDesktopRunMode } from './useDesktopRunMode.js';

/** Deliberately persistent while the demo-mode-only native exemptions are enabled. */
export function DevelopmentExemptions(): React.ReactElement | null {
  const mode = useDesktopRunMode();
  if (typeof desktopAppsBridge()?.listAppTargets !== 'function' || mode !== 'demo') return null;
  return (
    <aside
      role="note"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 100001,
        padding: '8px 16px',
        background: '#fff3cd',
        color: '#493800',
        fontSize: 14,
      }}
    >
      Demo mode: Terminal and ChatGPT are exempt from the app check. Strict mode has no exemptions.
      Keep the local server terminal running.
    </aside>
  );
}
