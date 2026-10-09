import { desktopAppsBridge } from './desktopApps.js';

/** Deliberately persistent while this development-only native policy is enabled. */
export function DevelopmentExemptions(): React.ReactElement | null {
  if (typeof desktopAppsBridge()?.listAppTargets !== 'function') return null;
  return <aside role="note" style={{ position: 'fixed', bottom: 0, left: 0, right: 0,
    zIndex: 100001, padding: '8px 16px', background: '#fff3cd', color: '#493800', fontSize: 14 }}>
    Development exemptions active: Terminal and ChatGPT. Remove these exam-policy exemptions before the presentation. Keep the local server terminal running.
  </aside>;
}
