/**
 * Lets sensors that hold unsent data (the audio recorder's last clip, voice bursts)
 * hand it over before the exam is submitted, instead of being cut off when the
 * exam screen closes. Each flush is bounded so submit never hangs on a sensor.
 */
type Flush = () => Promise<void> | void;

const flushes = new Set<Flush>();

/** Returns an unregister function. */
export function registerSubmitFlush(flush: Flush): () => void {
  flushes.add(flush);
  return () => void flushes.delete(flush);
}

/** Runs every registered flush in parallel and resolves when all settle or after `maxMs`. */
export async function runSubmitFlushes(maxMs = 3000): Promise<void> {
  if (flushes.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxMs);
  });
  const all = Promise.allSettled([...flushes].map(async (flush) => flush())).then(() => undefined);
  await Promise.race([all, timeout]);
  clearTimeout(timer);
}
