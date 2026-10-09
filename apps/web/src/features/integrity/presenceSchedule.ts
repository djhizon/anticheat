/**
 * When the mid-exam presence spot checks happen. They are never started by the student: they
 * fire only at a natural break — right after an item was answered or the student moved to
 * another question — once a random number of items (`itemsMin`..`itemsMax`) was answered AND a
 * random time (`gapMinMs`..`gapMaxMs`) has passed since the previous check, and never while the
 * student is typing. A missed check is retried at the very next item boundary.
 */
export interface PresenceScheduleConfig {
  readonly itemsMin: number;
  readonly itemsMax: number;
  readonly gapMinMs: number;
  readonly gapMaxMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_PRESENCE_SCHEDULE: PresenceScheduleConfig = {
  itemsMin: 2,
  itemsMax: 5,
  gapMinMs: 4 * MINUTE,
  gapMaxMs: 10 * MINUTE,
};

/** Typing within this long before a boundary means the student is mid-typing: no check. */
export const TYPING_QUIET_MS = 2000;

function range(value: unknown, scale: number): [number, number] | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/u.exec(
    typeof value === 'string' ? value : '',
  );
  if (!match) return null;
  const low = Number(match[1]) * scale;
  const high = Number(match[2]) * scale;
  return low > 0 && high >= low ? [low, high] : null;
}

/**
 * Reads `VITE_PRESENCE_ITEMS` ("min-max" answered items, e.g. "2-5") and
 * `VITE_PRESENCE_GAP_MINUTES` ("min-max" minutes, e.g. "4-10"). Invalid values keep defaults.
 */
export function presenceScheduleFromEnv(
  env: Readonly<Record<string, unknown>>,
): PresenceScheduleConfig {
  const items = range(env.VITE_PRESENCE_ITEMS, 1);
  const gap = range(env.VITE_PRESENCE_GAP_MINUTES, MINUTE);
  return {
    itemsMin: items ? Math.round(items[0]) : DEFAULT_PRESENCE_SCHEDULE.itemsMin,
    itemsMax: items ? Math.round(items[1]) : DEFAULT_PRESENCE_SCHEDULE.itemsMax,
    gapMinMs: gap?.[0] ?? DEFAULT_PRESENCE_SCHEDULE.gapMinMs,
    gapMaxMs: gap?.[1] ?? DEFAULT_PRESENCE_SCHEDULE.gapMaxMs,
  };
}

export interface BoundaryScheduler {
  /**
   * An item boundary happened (`answered`: an item was answered). Returns true when a check
   * should run now.
   */
  boundary(answered: boolean): boolean;
  /** A check finished (passed, or failed twice): start counting towards the next one. */
  completed(): void;
  /** The first try failed: retry at the next item boundary. */
  retryNext(): void;
}

export function createBoundaryScheduler(
  options: {
    readonly config?: PresenceScheduleConfig;
    readonly random?: () => number;
    readonly now?: () => number;
  } = {},
): BoundaryScheduler {
  const config = options.config ?? DEFAULT_PRESENCE_SCHEDULE;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const pick = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  let answered = 0;
  let target = 0;
  let earliest = 0;
  let retry = false;
  const reset = () => {
    answered = 0;
    target = pick(config.itemsMin, config.itemsMax);
    earliest = now() + pick(config.gapMinMs, config.gapMaxMs);
    retry = false;
  };
  reset();
  return {
    boundary(wasAnswered) {
      if (wasAnswered) answered += 1;
      if (retry) return true;
      return answered >= target && now() >= earliest;
    },
    completed: reset,
    retryNext() {
      retry = true;
    },
  };
}
