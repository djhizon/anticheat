import { useDesktopRunMode } from './useDesktopRunMode.js';
import { useReservedSpace } from './useReservedSpace.js';

/** Persistent reminder, shown only in the Electron app while demo mode is active. */
export function DemoModeBanner(): React.ReactElement | null {
  const shown = useDesktopRunMode() === 'demo';
  const ref = useReservedSpace<HTMLElement>('--demo-top-offset', shown);
  if (!shown) return null;
  return (
    <aside ref={ref} role="note" aria-label="Demo mode" className="demo-mode-banner">
      Demo mode — nothing is closed or blocked
    </aside>
  );
}
