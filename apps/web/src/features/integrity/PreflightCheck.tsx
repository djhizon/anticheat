import React, { useEffect, useRef, useState } from 'react';
import { desktopAppsBridge, parseAppTargets, type DesktopAppTarget } from './desktopApps.js';


const RISK_MAP: Record<string, string> = {
  'EXTERNAL_MONITOR': 'Multiple Displays Detected. Unplug all external monitors to continue.',

  'Google Chrome': 'Unauthorized Web Browser',
  'Safari': 'Unauthorized Web Browser',
  'Firefox': 'Unauthorized Web Browser',
  'Discord': 'Screen Sharing & Communication Risk',
  'Slack': 'Communication Risk',
  'Zoom': 'Screen Sharing Risk',
  'OBS': 'Virtual Camera / Recording Risk',
  'QuickTime Player': 'Screen Recording Risk',
  'Messages': 'Communication Risk',
  'Notes': 'Unauthorized Notes Access',
};

export function PreflightCheck({ onPassed, onCancel }: { onPassed: () => void; onCancel: () => void }) {
  const [runningApps, setRunningApps] = useState<DesktopAppTarget[]>([]);
  const [extraDisplays, setExtraDisplays] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onPassedRef = useRef(onPassed);
  onPassedRef.current = onPassed;
  const [checkRevision, setCheckRevision] = useState(0);

  // Check if we are inside the Electron container
  const isElectron = 'electronExam' in window;
  const electronAPI = desktopAppsBridge();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!isElectron) {
      // If we're just in a normal browser for development, skip the check
      onPassedRef.current();
      return;
    }

    // IPC can remain pending when the native process stops responding. Bound
    // the wait and ignore late replies after a retry, logout, or unmount.
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setError('The desktop environment check timed out. Retry or sign out; you can also close this window normally.');
      setLoading(false);
    }, 8000);
    const checkApps = async () => {
      setLoading(true);
      setError(null);
      setExtraDisplays(false);
      try {
        if (typeof electronAPI?.listAppTargets !== 'function') throw new Error('Restart the rebuilt desktop app.');
        const displays = await electronAPI.getDisplayCount();
        if (cancelled) return;
        if (!Number.isInteger(displays) || displays < 1) throw new Error('Invalid display response');
        if (displays > 1) {
          setExtraDisplays(true);
          setRunningApps([]);
          setLoading(false);
          return;
        }

        const apps = parseAppTargets(await electronAPI.listAppTargets());
        if (cancelled) return;
        const offendingApps = apps.filter(app => !app.exempt);
        
        if (offendingApps.length === 0) {
          onPassedRef.current();
        } else {
          setRunningApps(apps);
        }
      } catch (e) {
        if (!cancelled) setError('The desktop environment check failed. Keep both local servers running, restart the rebuilt app if needed, then retry or sign out.');
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    };

    checkApps();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [isElectron, electronAPI, checkRevision]);

  const handleRefresh = () => {
    setCheckRevision(c => c + 1);
  };

  async function requestClose(target: DesktopAppTarget, mode: 'quit' | 'force'): Promise<void> {
    if (!electronAPI || closing || target.protected || target.exempt) return;
    setClosing(true);
    setError(null);
    try {
      const result = await electronAPI.closeAppTarget(target.id, mode);
      if (!mounted.current) return;
      setNotice(result.message);
      setCheckRevision(c => c + 1);
    } catch {
      if (mounted.current) setError('The close request failed. Re-check before trying again.');
    } finally { if (mounted.current) setClosing(false); }
  }

  if (!isElectron || loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#000', color: '#fff' }}>
        <h2 role="status">Performing Pre-flight Environment Checks...</h2>
        <button type="button" onClick={onCancel}>Sign out</button>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.95)', color: '#fff', zIndex: 99999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#1e1e1e', padding: '3rem', borderRadius: '12px', border: '1px solid #333', maxWidth: '600px', width: '100%', textAlign: 'center' }}>
        <h2 style={{ color: '#ff6b6b' }}>⚠️ Security Gate ⚠️</h2>
        {error !== null && <p role="alert">{error}</p>}
        <p style={{ fontSize: '1.1rem', margin: '1rem 0 2rem' }}>
          Save your work, then request a normal quit. If an app stays open, re-check after 3 seconds to enable a separately confirmed Force Quit. Force Quit can lose unsaved work.
        </p>
        <p>Terminal and ChatGPT are temporarily exempt. The exam runtime and its server dependencies cannot be closed here.</p>
        {notice !== null && <p role="status">{notice}</p>}
        {extraDisplays && <p role="alert">{RISK_MAP.EXTERNAL_MONITOR}</p>}
        
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 2rem 0', textAlign: 'left', maxHeight: '300px', overflowY: 'auto' }}>
          {runningApps.map(app => (
            <li key={app.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: '#2a2a2a', marginBottom: '0.5rem', borderRadius: '8px' }}>
              <div>
                <strong style={{ display: 'block', fontSize: '1.1rem' }}>{app.name}{app.exempt ? ' — Exempt' : app.protected ? ' — Protected' : ''}</strong>
                <span style={{ color: '#aaa', fontSize: '0.9rem' }}>
                  {app.reason || RISK_MAP[app.name] || 'Application must be closed before the exam'}
                </span>
              </div>
              {!app.protected && !app.exempt && <div>
                <button type="button" disabled={closing} onClick={() => void requestClose(app, 'quit')}>Quit normally</button>
                {app.canForce && <button type="button" disabled={closing} onClick={() => void requestClose(app, 'force')}>Force Quit…</button>}
              </div>}
            </li>
          ))}
        </ul>
        
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <button type="button" onClick={onCancel}>Sign out</button>
          <button 
            disabled={closing}
            onClick={handleRefresh}
            style={{ background: '#444', color: 'white', border: 'none', padding: '0.75rem 2rem', borderRadius: '6px', cursor: 'pointer', fontSize: '1.1rem' }}
          >
            Re-check Environment
          </button>
        </div>
      </div>
    </div>
  );
}
