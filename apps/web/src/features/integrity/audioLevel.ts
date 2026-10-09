export const METER_BARS = 6;
const FRAME_INTERVAL_MS = 66;
const REDUCED_FRAME_INTERVAL_MS = 250;

export interface LevelReading {
  /** Per-band levels, 0..1, length METER_BARS. */
  readonly bars: readonly number[];
  /** Overall level, 0..1. */
  readonly level: number;
}

/**
 * Drives a level meter from the real microphone via a Web Audio AnalyserNode.
 * Owns its AudioContext (no output connection) and releases it on the returned stop().
 */
export function createLevelMeter(
  stream: MediaStream,
  onLevel: (reading: LevelReading) => void,
  reducedMotion = false,
): () => void {
  let stopped = false;
  let frame: number | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const interval = reducedMotion ? REDUCED_FRAME_INTERVAL_MS : FRAME_INTERVAL_MS;

  function release() {
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    try {
      source?.disconnect();
    } catch {
      // already disconnected
    }
    source = null;
    void context?.close().catch(() => {});
    context = null;
  }

  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    void context.resume?.().catch(() => {});
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const usable = Math.max(METER_BARS, Math.floor(bins.length / 2));
    const perBar = Math.floor(usable / METER_BARS);
    let last = -Infinity;
    const tick = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(tick);
      if (now - last < interval) return;
      last = now;
      analyser.getByteFrequencyData(bins);
      const bars: number[] = [];
      let total = 0;
      for (let bar = 0; bar < METER_BARS; bar++) {
        let sum = 0;
        for (let i = bar * perBar; i < (bar + 1) * perBar; i++) sum += bins[i] ?? 0;
        const value = Math.min(1, sum / perBar / 200);
        bars.push(value);
        total += value;
      }
      onLevel({ bars, level: total / METER_BARS });
    };
    frame = requestAnimationFrame(tick);
  } catch {
    // The meter is cosmetic: failure must never affect recording.
    release();
  }
  return release;
}
