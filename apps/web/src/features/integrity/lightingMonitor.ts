import { isPoorLighting, type LightingReport } from './lightingAnalysis.js';

/** How often the exam samples lighting. */
export const LIGHTING_SAMPLE_INTERVAL_MS = 5000;
/** Poor lighting must last this long before a banner is shown and the event is logged. */
export const LIGHTING_POOR_AFTER_MS = 20_000;
/** Good lighting must last this long before the banner is hidden and the episode ends. */
export const LIGHTING_RECOVER_AFTER_MS = 10_000;
/** While poor lighting continues, the timeline gets at most one entry per this interval. */
export const LIGHTING_RELOG_MS = 5 * 60_000;

export interface LightingVerdict {
  /** The report to show in the non-blocking banner, or null for no banner. */
  readonly banner: LightingReport | null;
  /** Set once when an entry should be logged to the timeline. */
  readonly log: LightingReport | null;
}

/**
 * Decides, from a stream of lighting reports, when to warn and when to log. It never blocks
 * anything: the result is only a banner and an informational timeline entry.
 */
export function createLightingTracker(now: () => number = Date.now) {
  let poorSince: number | null = null;
  let goodSince: number | null = null;
  let lastLog = -Infinity;
  let banner: LightingReport | null = null;
  return {
    observe(report: LightingReport | null): LightingVerdict {
      if (report === null) return { banner, log: null };
      const at = now();
      if (isPoorLighting(report.class)) {
        goodSince = null;
        poorSince ??= at;
        if (at - poorSince < LIGHTING_POOR_AFTER_MS) return { banner, log: null };
        banner = report;
        if (at - lastLog >= LIGHTING_RELOG_MS) {
          lastLog = at;
          return { banner, log: report };
        }
        return { banner, log: null };
      }
      goodSince ??= at;
      if (at - goodSince >= LIGHTING_RECOVER_AFTER_MS) {
        poorSince = null;
        banner = null;
      }
      return { banner, log: null };
    },
    reset(): void {
      poorSince = null;
      goodSince = null;
      banner = null;
    },
  };
}
