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
