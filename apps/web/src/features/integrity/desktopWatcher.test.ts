import { expect, it, vi } from 'vitest';

import {
  startDesktopWatcher,
  type AppSnapshot,
  type DesktopWatcherBridge,
} from './desktopWatcher.js';

function fakeBridge() {
  let listener: ((snapshot: AppSnapshot) => void) | null = null;
  const bridge: DesktopWatcherBridge = {
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
    onAppSnapshot: vi.fn((callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
  };
  return { bridge, emit: (snapshot: AppSnapshot) => listener?.(snapshot) };
}

it('forwards only changed, suspicious snapshots for the current attempt', () => {
  const { bridge, emit } = fakeBridge();
  const send = vi.fn(async () => ({}));
  const stop = startDesktopWatcher(bridge, 'a1', send);
  expect(bridge.startWatcher).toHaveBeenCalledWith('a1');

  emit({ attemptId: 'a1', foregroundApp: 'Exam Anti-Cheat', displayCount: 1 });
  emit({ attemptId: 'a1', foregroundApp: 'Discord', displayCount: 1 });
  emit({ attemptId: 'a1', foregroundApp: 'Discord', displayCount: 1 });
  emit({ attemptId: 'other', foregroundApp: 'Slack', displayCount: 1 });
  emit({ attemptId: 'a1', foregroundApp: 'Exam Anti-Cheat', displayCount: 2 });

  expect(send.mock.calls).toEqual([
    [{ foregroundApp: 'Discord', displayCount: 1 }],
    [{ foregroundApp: 'Exam Anti-Cheat', displayCount: 2 }],
  ]);
  stop();
  expect(bridge.stopWatcher).toHaveBeenCalled();
  emit({ attemptId: 'a1', foregroundApp: 'Zoom', displayCount: 1 });
  expect(send).toHaveBeenCalledTimes(2);
});

it('reports each capture-like display once', () => {
  const { bridge, emit } = fakeBridge();
  const send = vi.fn(async (_body: Record<string, unknown>) => ({}));
  startDesktopWatcher(bridge, 'a1', send);
  const snap = {
    attemptId: 'a1',
    foregroundApp: 'Exam Anti-Cheat',
    displayCount: 2,
    captureDisplays: ['Elgato HD60'],
  };
  emit(snap);
  emit({ ...snap, foregroundApp: 'Electron' });
  expect(
    send.mock.calls.filter(
      ([body]) => (body as { event?: string }).event === 'capture_display_connected',
    ),
  ).toHaveLength(1);
});

it('flags a Demo-mode attempt once, and never flags Strict', () => {
  const { bridge, emit } = fakeBridge();
  const send = vi.fn(async (_body: Record<string, unknown>) => ({}));
  startDesktopWatcher(bridge, 'a1', send);
  const snap = { attemptId: 'a1', foregroundApp: 'Exam Anti-Cheat', displayCount: 1 };
  emit({ ...snap, runMode: 'strict' });
  expect(send).not.toHaveBeenCalled();
  emit({ ...snap, runMode: 'demo' });
  emit({ ...snap, runMode: 'demo' });
  expect(send.mock.calls).toEqual([[{ event: 'desktop_demo_mode' }]]);
});
