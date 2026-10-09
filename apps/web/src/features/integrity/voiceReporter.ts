/**
 * Coalesces the 200 ms "sound activity" pings into bursts (a gap of more than
 * BURST_GAP_MS ends one) and posts a few small summaries (start, length, peak
 * level) through the telemetry endpoint. No audio leaves here. Failures are
 * dropped so the exam never depends on this.
 */
export const BURST_GAP_MS = 3000;
const MAX_QUEUE = 100;

export interface VoiceReporterApi {
  uploadTelemetry(attemptId: string, payload: unknown): Promise<void>;
}

export function createVoiceReporter(
  attemptId: string,
  api: VoiceReporterApi,
  clock: () => number = Date.now,
) {
  let burst: { start: number; end: number; peakDb: number } | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: Array<{ timestamp: number; durationMs: number; peakDb: number }> = [];

  function close(): void {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
    if (burst === null) return;
    if (queue.length < MAX_QUEUE) {
      queue.push({
        timestamp: burst.start,
        durationMs: Math.max(1, Math.round(burst.end - burst.start)),
        peakDb: Math.round(burst.peakDb * 10) / 10,
      });
    }
    burst = null;
    send();
  }
  function send(): void {
    if (queue.length === 0) return;
    const voice = queue.splice(0);
    api.uploadTelemetry(attemptId, { voice }).catch(() => {});
  }

  return {
    detected(durationMs: number, peakDb: number): void {
      const now = clock();
      if (burst === null) burst = { start: now - durationMs, end: now, peakDb };
      else burst = { ...burst, end: now, peakDb: Math.max(burst.peakDb, peakDb) };
      if (closeTimer !== null) clearTimeout(closeTimer);
      closeTimer = setTimeout(close, BURST_GAP_MS);
    },
    stop(): void {
      close();
    },
  };
}
