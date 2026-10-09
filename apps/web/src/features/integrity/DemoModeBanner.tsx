import { useDesktopRunMode } from './useDesktopRunMode.js';

/** Persistent reminder, shown only in the Electron app while demo mode is active. */
export function DemoModeBanner(): React.ReactElement | null {
  if (useDesktopRunMode() !== 'demo') return null;
  return (
    <aside
      role="note"
      aria-label="Demo mode"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        zIndex: 100001,
        padding: '2px 10px',
        background: '#d1ecf1',
        color: '#0c5460',
        fontSize: 12,
        borderBottomLeftRadius: 6,
        pointerEvents: 'none',
      }}
    >
      Demo mode — nothing is closed or blocked
    </aside>
  );
}
