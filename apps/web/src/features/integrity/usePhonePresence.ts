import { useEffect, useState } from 'react';
import type { ExamApi, PhonePresenceStatus } from '../exam/api.js';

const MAX_CONSECUTIVE_FAILURES = 3;

export function usePhonePresence(
  attemptId: string | undefined,
  enabled: boolean,
  api: ExamApi | undefined,
) {
  const [snapshot, setSnapshot] = useState<{
    attemptId: string;
    status: PhonePresenceStatus;
    expires: number;
  } | null>(null);
  const [failures, setFailures] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setSnapshot(null);
    setFailures(0);
    if (!attemptId || !enabled || !api) return;
    let disposed = false;
    let pending: AbortController | null = null;
    async function poll() {
      if (disposed || pending) return;
      const controller = new AbortController();
      pending = controller;
      const started = performance.now();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const status = await api!.getPhonePresence(attemptId!, controller.signal);
        if (!disposed) {
          setSnapshot({ attemptId: attemptId!, status, expires: started + status.remainingMs });
          setFailures(0);
        }
      } catch {
        // Keep the last known snapshot: a transient error must not block students who never
        // paired a phone. Required attempts still expire locally and block after repeated failures.
        if (!disposed) setFailures((n) => n + 1);
      } finally {
        clearTimeout(timeout);
        pending = null;
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 1000);
    const clock = setInterval(() => setNow(performance.now()), 250);
    return () => {
      disposed = true;
      pending?.abort();
      clearInterval(interval);
      clearInterval(clock);
    };
  }, [attemptId, enabled, api]);
  const current = snapshot?.attemptId === attemptId ? snapshot : null;
  const connected = !!current?.status.active && current.expires > now;
  const required = current?.status.required ?? null;
  const unreachable = failures >= MAX_CONSECUTIVE_FAILURES;
  return {
    blocked:
      enabled &&
      !!api &&
      (!current || (current.status.required === true && (!connected || unreachable))),
    connected,
    required,
    checking: current === null,
  };
}
