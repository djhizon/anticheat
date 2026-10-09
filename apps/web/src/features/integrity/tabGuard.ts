/**
 * Triple-redundancy exam tab guard.
 * Uses localStorage + BroadcastChannel + Web Locks.
 * Key is the ASSIGNMENT ID (not attempt ID) so it works before the attempt loads.
 *
 * When a duplicate tab is detected, both tabs are immediately blocked.
 */
export type ViolationType =
  | 'duplicate_tab'
  | 'focus_lost'
  | 'page_hidden'
  | 'fullscreen_exit'
  | 'paste_detected'
  | 'overlay_detected';

export interface ViolationEvent {
  readonly type: ViolationType;
  readonly timestamp: number;
  readonly count: number;
}

export function createTabGuard(
  examKey: string,
  onViolation: (v: ViolationEvent) => void,
) {
  const myId = crypto.randomUUID();
  const lsKey = `exam-tab-guard:${examKey}`;
  const channelName = `exam-guard:${examKey}`;
  const channel = new BroadcastChannel(channelName);
  let duplicateCount = 0;

  function fireViolation(type: ViolationType) {
    if (type === 'duplicate_tab') duplicateCount += 1;
    onViolation({ type, timestamp: Date.now(), count: duplicateCount });
  }

  // ── 1. localStorage — fastest cross-tab signal ─────────────────────────
  const existing = localStorage.getItem(lsKey);
  if (existing !== null && existing !== myId) {
    // Another tab already holds the key → WE are the duplicate
    fireViolation('duplicate_tab');
  } else {
    localStorage.setItem(lsKey, myId);
  }

  // ── 2. BroadcastChannel — bidirectional real-time ──────────────────────
  // Announce ourselves to any already-open tab
  channel.postMessage({ type: 'tab-ping', from: myId });

  channel.onmessage = (e: MessageEvent<{ type: string; from: string }>) => {
    if (e.data.from === myId) return; // own echo, ignore
    if (e.data.type === 'tab-ping' || e.data.type === 'tab-block') {
      // Another exam tab is alive → block both
      fireViolation('duplicate_tab');
      // Tell the other tab it's blocked too
      channel.postMessage({ type: 'tab-block', from: myId });
    }
  };

  // ── 3. StorageEvent — catches tabs that bypass BroadcastChannel ────────
  const onStorage = (e: StorageEvent) => {
    if (e.key === lsKey && e.newValue !== null && e.newValue !== myId) {
      fireViolation('duplicate_tab');
      channel.postMessage({ type: 'tab-block', from: myId });
    }
  };
  window.addEventListener('storage', onStorage);

  // ── 4. Web Locks — OS-level mutex (won't work across browsers) ─────────
  let releaseLock: (() => void) | null = null;
  if ('locks' in navigator) {
    void navigator.locks.request(
      `exam-lock:${examKey}`,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (lock === null) {
          fireViolation('duplicate_tab');
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => { releaseLock = resolve; });
      },
    );
  }

  function release() {
    const current = localStorage.getItem(lsKey);
    if (current === myId) localStorage.removeItem(lsKey);
    channel.close();
    window.removeEventListener('storage', onStorage);
    releaseLock?.();
  }

  return { release };
}

/** Thresholds before a violation becomes a kick */
export const VIOLATION_KICK_THRESHOLD: Record<ViolationType, number> = {
  duplicate_tab: 1,    // instant kick — zero tolerance
  focus_lost: 5,       // 5 focus losses = kick
  page_hidden: 3,      // 3 page hides = kick
  fullscreen_exit: 3,  // 3 fullscreen exits = kick
  paste_detected: 10,  // 10 pastes = kick (already blocked but logged)
  overlay_detected: 1, // 1 transparent iframe = instant kick
};

export function shouldKick(violations: readonly ViolationEvent[]): ViolationEvent | null {
  const counts = new Map<ViolationType, number>();
  for (const v of violations) {
    counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
  }
  for (const [type, count] of counts) {
    const threshold = VIOLATION_KICK_THRESHOLD[type] ?? Infinity;
    if (count >= threshold) {
      return [...violations].reverse().find((v: ViolationEvent) => v.type === type) ?? null;
    }
  }
  return null;
}
