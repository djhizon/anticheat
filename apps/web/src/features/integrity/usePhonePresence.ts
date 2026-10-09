import { useEffect, useState } from 'react';
import type { ExamApi, PhonePresenceStatus } from '../exam/api.js';

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
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setSnapshot(null);
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
        if (!disposed)
          setSnapshot({ attemptId: attemptId!, status, expires: started + status.remainingMs });
      } catch {
        if (!disposed) setSnapshot(null); // Unknown server state is never permission to answer.
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
  return {
    blocked: enabled && !!api && (!current || (current.status.required && !connected)),
    connected,
    required: current?.status.required ?? null,
    checking: current === null,
    deskCamera: current?.status.deskCamera ?? null,
  };
}
