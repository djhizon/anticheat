/**
 * Pure, DOM-free detectors for input-behaviour signals. They consume timestamps,
 * counts and pointer positions only: never which key was pressed and never a
 * stream of coordinates leaves this module (only aggregates do).
 *
 * Every threshold is a named constant so docs/LOCAL_AI.md and the tests agree.
 */

export const INPUT_THRESHOLDS = {
  /** Pointer outside the exam window this long while the window keeps focus = event. */
  outsideEventMs: 5_000,
  /** A jump bigger than this between two consecutive pointer events within one frame. */
  teleportPx: 400,
  teleportMaxDtMs: 34,
  /** A segment longer than this gap between samples ends and is evaluated. */
  segmentGapMs: 100,
  segmentMinSamples: 15,
  segmentMinPathPx: 150,
  /** chord / path length at or above this is "perfectly straight". */
  roboticStraightness: 0.9995,
  /** velocity coefficient of variation below this is "constant velocity". */
  roboticVelocityCv: 0.05,
  /** Per-window counts that turn pointer statistics into a `synthetic_input` event. */
  syntheticUntrusted: 3,
  syntheticTeleports: 3,
  syntheticRobotic: 2,
  /** Text injection: this many chars inserted inside the window with fewer keydowns. */
  injectionChars: 30,
  injectionWindowMs: 300,
  /** Intervals longer than this are pauses, not rhythm. */
  rhythmMaxIntervalMs: 2_000,
  uniformMinKeys: 40,
  uniformMaxCv: 0.08,
  fastWpm: 150,
  fastWpmMinChars: 40,
  fastWpmConsecutiveWindows: 2,
  idleMs: 60_000,
  burstWindowMs: 10_000,
  burstChars: 120,
  /** Pointer still for this long when text is injected counts as "idle pointer". */
  pointerIdleMs: 10_000,
  baselineMinKeys: 60,
  baselineLearnMs: 120_000,
  baselineMaxLearnMs: 300_000,
  driftMinKeys: 30,
  driftZ: 4,
  driftRelative: 0.3,
  driftConsecutiveWindows: 2,
} as const;

const T = INPUT_THRESHOLDS;

const mean = (values: readonly number[]): number =>
  values.reduce((a, b) => a + b, 0) / values.length;
const stdDev = (values: readonly number[], avg = mean(values)): number =>
  Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length);
const round = (value: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// ── Pointer motion ───────────────────────────────────────────────────────────

export interface PointerSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly trusted: boolean;
}

export interface PointerMotionStats {
  readonly events: number;
  readonly untrusted: number;
  readonly teleports: number;
  readonly roboticSegments: number;
  /** Mean chord/path length over human-length segments (1 = ruler straight). */
  readonly straightness: number | null;
  /** Mean velocity coefficient of variation over those segments. */
  readonly velocityCv: number | null;
}

export function analyseSegment(
  samples: readonly PointerSample[],
): { straightness: number; velocityCv: number; pathPx: number } | null {
  if (samples.length < 8) return null;
  let path = 0;
  const velocities: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    path += d;
    const dt = b.t - a.t;
    if (dt > 0) velocities.push(d / dt);
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  if (path < 50 || velocities.length < 2) return null;
  const avgV = mean(velocities);
  const velocityCv = avgV > 0 ? stdDev(velocities, avgV) / avgV : 0;
  return { straightness: chord / path, velocityCv, pathPx: path };
}

export function createPointerMotionAnalyzer() {
  let segment: PointerSample[] = [];
  let events = 0;
  let untrusted = 0;
  let teleports = 0;
  let robotic = 0;
  let straightSum = 0;
  let cvSum = 0;
  let segments = 0;

  function closeSegment(): void {
    const result = analyseSegment(segment);
    if (result !== null) {
      straightSum += result.straightness;
      cvSum += result.velocityCv;
      segments += 1;
      if (
        segment.length >= T.segmentMinSamples &&
        result.pathPx >= T.segmentMinPathPx &&
        result.straightness >= T.roboticStraightness &&
        result.velocityCv < T.roboticVelocityCv
      ) {
        robotic += 1;
      }
    }
    segment = [];
  }

  return {
    push(sample: PointerSample): void {
      events += 1;
      if (!sample.trusted) untrusted += 1;
      const prev = segment[segment.length - 1];
      if (prev !== undefined) {
        const dt = sample.t - prev.t;
        if (dt > T.segmentGapMs) {
          closeSegment();
        } else if (
          dt <= T.teleportMaxDtMs &&
          Math.hypot(sample.x - prev.x, sample.y - prev.y) > T.teleportPx
        ) {
          teleports += 1;
          closeSegment();
        }
      }
      segment.push(sample);
    },
    /** The pointer re-entered the window or focus returned: the next jump is not a teleport. */
    breakSegment(): void {
      closeSegment();
    },
    drain(): PointerMotionStats {
      closeSegment();
      const stats: PointerMotionStats = {
        events,
        untrusted,
        teleports,
        roboticSegments: robotic,
        straightness: segments > 0 ? round(straightSum / segments) : null,
        velocityCv: segments > 0 ? round(cvSum / segments) : null,
      };
      events = untrusted = teleports = robotic = segments = 0;
      straightSum = cvSum = 0;
      return stats;
    },
  };
}

/** True when a window's pointer statistics look like automation or remote control. */
export function looksSynthetic(stats: {
  readonly untrusted: number;
  readonly teleports: number;
  readonly roboticSegments: number;
}): boolean {
  return (
    stats.untrusted >= T.syntheticUntrusted ||
    stats.teleports >= T.syntheticTeleports ||
    stats.roboticSegments >= T.syntheticRobotic
  );
}

// ── Pointer outside the window ───────────────────────────────────────────────

export type PointerEdge = 'left' | 'right' | 'top' | 'bottom';

/** Which viewport edge the pointer was nearest when it left (no coordinates kept). */
export function nearestEdge(
  x: number,
  y: number,
  width: number,
  height: number,
): PointerEdge | null {
  if (width <= 0 || height <= 0) return null;
  const distances: Array<[PointerEdge, number]> = [
    ['left', x],
    ['right', width - x],
    ['top', y],
    ['bottom', height - y],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]![0];
}

export interface OutsideStats {
  readonly leaves: number;
  readonly outsideMs: number;
  readonly longestMs: number;
  readonly edge: PointerEdge | null;
}

export function createPointerOutsideTracker() {
  let outsideSince: number | null = null;
  let currentEdge: PointerEdge | null = null;
  let eventFired = false;
  let leaves = 0;
  let outsideMs = 0;
  let longest = 0;
  let longestEdge: PointerEdge | null = null;

  function close(t: number): void {
    if (outsideSince === null) return;
    const spent = Math.max(0, t - outsideSince);
    outsideMs += spent;
    if (spent > longest) {
      longest = spent;
      longestEdge = currentEdge;
    }
    outsideSince = null;
  }

  return {
    leave(t: number, edge: PointerEdge | null): void {
      if (outsideSince !== null) return;
      outsideSince = t;
      currentEdge = edge;
      eventFired = false;
      leaves += 1;
    },
    enter(t: number): void {
      close(t);
    },
    get isOutside(): boolean {
      return outsideSince !== null;
    },
    /** Returns true once per excursion when it passes the threshold with the window focused. */
    check(t: number, windowFocused: boolean): boolean {
      if (outsideSince === null || eventFired || !windowFocused) return false;
      if (t - outsideSince < T.outsideEventMs) return false;
      eventFired = true;
      return true;
    },
    drain(t: number): OutsideStats {
      // An excursion in progress is split at the window edge so each row has its own share.
      let stats: OutsideStats;
      if (outsideSince !== null) {
        const spent = Math.max(0, t - outsideSince);
        const total = outsideMs + spent;
        const lg = Math.max(longest, spent);
        stats = {
          leaves,
          outsideMs: Math.round(total),
          longestMs: Math.round(lg),
          edge: spent >= longest ? currentEdge : longestEdge,
        };
        outsideSince = t;
        leaves = 0;
      } else {
        stats = {
          leaves,
          outsideMs: Math.round(outsideMs),
          longestMs: Math.round(longest),
          edge: longestEdge,
        };
        leaves = 0;
      }
      outsideMs = 0;
      longest = 0;
      longestEdge = null;
      return stats;
    },
  };
}

// ── Text injection ───────────────────────────────────────────────────────────

/**
 * Flags a long run of characters that appeared inside a very short window with
 * fewer keydowns than characters (autotyper, injected text). Composition (IME)
 * and the browser's own composition input types are never counted.
 */
export function createInjectionDetector() {
  let keys: number[] = [];
  let inserts: Array<{ t: number; chars: number }> = [];
  return {
    keyDown(t: number): void {
      keys.push(t);
    },
    /** `composing` covers IME composition: those insertions are ignored entirely. */
    insert(t: number, chars: number, composing: boolean): boolean {
      if (composing || chars <= 0) return false;
      const cutoff = t - T.injectionWindowMs;
      keys = keys.filter((k) => k >= cutoff);
      inserts = inserts.filter((i) => i.t >= cutoff);
      inserts.push({ t, chars });
      const total = inserts.reduce((a, i) => a + i.chars, 0);
      if (total >= T.injectionChars && keys.length < total) {
        inserts = [];
        keys = [];
        return true;
      }
      return false;
    },
  };
}

// ── Typing rhythm ────────────────────────────────────────────────────────────

export type KeyKind = 'char' | 'correction';

export interface TypingStats {
  readonly keys: number;
  readonly chars: number;
  readonly corrections: number;
  readonly meanDwellMs: number | null;
  readonly meanIntervalMs: number | null;
  readonly intervalCv: number | null;
  readonly wpm: number | null;
  /** Rolling intervals looked scripted (CV below threshold over enough keys). */
  readonly uniformRhythm: boolean;
  /** Two consecutive windows above the sustained-speed threshold. */
  readonly sustainedFast: boolean;
  /** Sums for baseline learning (not uploaded). */
  readonly sums: TypingSums;
}

export interface TypingSums {
  readonly n: number;
  readonly sumDwell: number;
  readonly sumDwellSq: number;
  readonly nInterval: number;
  readonly sumInterval: number;
  readonly sumIntervalSq: number;
}

export function createTypingAnalyzer() {
  let lastDownAt: number | null = null;
  let dwells: number[] = [];
  let intervals: number[] = [];
  let rolling: number[] = [];
  let chars = 0;
  let corrections = 0;
  let uniform = false;
  let fastWindows = 0;

  return {
    /** One completed keystroke. Interval is keydown-to-keydown; pauses are excluded. */
    record(downAt: number, dwellMs: number, kind: KeyKind): void {
      if (kind === 'char') chars += 1;
      else corrections += 1;
      if (dwellMs >= 0 && dwellMs < 2_000) dwells.push(dwellMs);
      if (lastDownAt !== null) {
        const interval = downAt - lastDownAt;
        if (interval > 0 && interval <= T.rhythmMaxIntervalMs) {
          intervals.push(interval);
          rolling.push(interval);
          if (rolling.length > T.uniformMinKeys) rolling.shift();
          if (rolling.length >= T.uniformMinKeys) {
            const avg = mean(rolling);
            if (avg > 0 && stdDev(rolling, avg) / avg < T.uniformMaxCv) {
              uniform = true;
              rolling = [];
            }
          }
        }
      }
      lastDownAt = downAt;
    },
    /** A long pause or lost focus: the next key does not form an interval with the last. */
    breakRun(): void {
      lastDownAt = null;
    },
    drain(): TypingStats {
      const keys = chars + corrections;
      const meanDwell = dwells.length > 0 ? mean(dwells) : null;
      const meanInterval = intervals.length > 0 ? mean(intervals) : null;
      const cv =
        meanInterval !== null && meanInterval > 0 && intervals.length >= 5
          ? stdDev(intervals, meanInterval) / meanInterval
          : null;
      const activeMs = intervals.reduce((a, b) => a + b, 0);
      const wpm = activeMs >= 3_000 && chars >= 10 ? chars / 5 / (activeMs / 60_000) : null;
      if (wpm !== null && wpm > T.fastWpm && chars >= T.fastWpmMinChars) fastWindows += 1;
      else fastWindows = 0;
      const stats: TypingStats = {
        keys,
        chars,
        corrections,
        meanDwellMs: meanDwell === null ? null : Math.round(meanDwell),
        meanIntervalMs: meanInterval === null ? null : Math.round(meanInterval),
        intervalCv: cv === null ? null : round(cv),
        wpm: wpm === null ? null : Math.round(wpm),
        uniformRhythm: uniform,
        sustainedFast: fastWindows >= T.fastWpmConsecutiveWindows,
        sums: {
          n: dwells.length,
          sumDwell: dwells.reduce((a, b) => a + b, 0),
          sumDwellSq: dwells.reduce((a, b) => a + b * b, 0),
          nInterval: intervals.length,
          sumInterval: intervals.reduce((a, b) => a + b, 0),
          sumIntervalSq: intervals.reduce((a, b) => a + b * b, 0),
        },
      };
      dwells = [];
      intervals = [];
      chars = 0;
      corrections = 0;
      uniform = false;
      if (stats.sustainedFast) fastWindows = 0;
      return stats;
    },
  };
}

// ── Burst after idle ─────────────────────────────────────────────────────────

/**
 * A long stretch with no keys and no pointer movement while the window kept focus,
 * followed by a fast burst of a long answer (typed elsewhere and transcribed?).
 */
export function createBurstAfterIdleDetector(start: number) {
  let lastActivity: number | null = start;
  let burstStart: number | null = null;
  let burstChars = 0;
  return {
    /** Pointer movement or any non-text activity. */
    activity(t: number): void {
      lastActivity = t;
    },
    /** Focus or visibility was lost: idle time no longer counts as "focus kept". */
    focusBroken(): void {
      lastActivity = null;
      burstStart = null;
      burstChars = 0;
    },
    chars(t: number, count: number): boolean {
      if (count <= 0) return false;
      if (burstStart !== null && t - burstStart > T.burstWindowMs) {
        burstStart = null;
        burstChars = 0;
      }
      if (burstStart === null && lastActivity !== null && t - lastActivity > T.idleMs) {
        burstStart = t;
        burstChars = 0;
      }
      lastActivity = t;
      if (burstStart === null) return false;
      burstChars += count;
      if (burstChars >= T.burstChars) {
        burstStart = null;
        burstChars = 0;
        return true;
      }
      return false;
    },
  };
}

// ── Typing baseline drift ────────────────────────────────────────────────────

export interface TypingProfile {
  readonly n: number;
  readonly meanDwellMs: number;
  readonly sdDwellMs: number;
  readonly nInterval: number;
  readonly meanIntervalMs: number;
  readonly sdIntervalMs: number;
}

const EMPTY_SUMS: TypingSums = {
  n: 0,
  sumDwell: 0,
  sumDwellSq: 0,
  nInterval: 0,
  sumInterval: 0,
  sumIntervalSq: 0,
};

export function addSums(a: TypingSums, b: TypingSums): TypingSums {
  return {
    n: a.n + b.n,
    sumDwell: a.sumDwell + b.sumDwell,
    sumDwellSq: a.sumDwellSq + b.sumDwellSq,
    nInterval: a.nInterval + b.nInterval,
    sumInterval: a.sumInterval + b.sumInterval,
    sumIntervalSq: a.sumIntervalSq + b.sumIntervalSq,
  };
}

export function profileFromSums(sums: TypingSums): TypingProfile | null {
  if (sums.n < T.baselineMinKeys || sums.nInterval < T.baselineMinKeys) return null;
  const meanDwell = sums.sumDwell / sums.n;
  const meanInterval = sums.sumInterval / sums.nInterval;
  return {
    n: sums.n,
    meanDwellMs: meanDwell,
    sdDwellMs: Math.sqrt(Math.max(0, sums.sumDwellSq / sums.n - meanDwell ** 2)),
    nInterval: sums.nInterval,
    meanIntervalMs: meanInterval,
    sdIntervalMs: Math.sqrt(Math.max(0, sums.sumIntervalSq / sums.nInterval - meanInterval ** 2)),
  };
}

export interface DriftReading {
  readonly zDwell: number;
  readonly zInterval: number;
  readonly strong: boolean;
}

function zScore(
  windowMean: number,
  windowN: number,
  baseMean: number,
  baseSd: number,
  baseN: number,
): number {
  const se = Math.sqrt(baseSd ** 2 / windowN + baseSd ** 2 / baseN);
  return se > 0 ? (windowMean - baseMean) / se : 0;
}

/** z-score of this window's mean dwell and interval against the baseline profile. */
export function driftAgainst(profile: TypingProfile, sums: TypingSums): DriftReading | null {
  if (sums.n < T.driftMinKeys || sums.nInterval < T.driftMinKeys) return null;
  const windowDwell = sums.sumDwell / sums.n;
  const windowInterval = sums.sumInterval / sums.nInterval;
  const zDwell = zScore(windowDwell, sums.n, profile.meanDwellMs, profile.sdDwellMs, profile.n);
  const zInterval = zScore(
    windowInterval,
    sums.nInterval,
    profile.meanIntervalMs,
    profile.sdIntervalMs,
    profile.nInterval,
  );
  const relDwell = Math.abs(windowDwell - profile.meanDwellMs) / (profile.meanDwellMs || 1);
  const relInterval =
    Math.abs(windowInterval - profile.meanIntervalMs) / (profile.meanIntervalMs || 1);
  const strong =
    Math.abs(zDwell) >= T.driftZ &&
    Math.abs(zInterval) >= T.driftZ &&
    relDwell >= T.driftRelative &&
    relInterval >= T.driftRelative;
  return { zDwell: round(zDwell, 2), zInterval: round(zInterval, 2), strong };
}

/**
 * Learns a baseline (from setup typing when supplied, else the first 2 minutes of
 * exam typing) and then reports drift per window. `notice` is true after enough
 * consecutive strongly shifted windows.
 */
export function createDriftTracker(initial: TypingProfile | null) {
  let profile = initial;
  let learned: TypingSums = EMPTY_SUMS;
  let learnedMs = 0;
  let strongRun = 0;
  return {
    get profile(): TypingProfile | null {
      return profile;
    },
    observe(sums: TypingSums, windowMs: number): { drift: DriftReading | null; notice: boolean } {
      if (profile === null) {
        learned = addSums(learned, sums);
        learnedMs += windowMs;
        if (learnedMs >= T.baselineLearnMs) {
          const candidate = profileFromSums(learned);
          if (candidate !== null) profile = candidate;
          else if (learnedMs >= T.baselineMaxLearnMs) {
            // Too little typing to build a baseline: start over rather than guess.
            learned = EMPTY_SUMS;
            learnedMs = 0;
          }
        }
        return { drift: null, notice: false };
      }
      const drift = driftAgainst(profile, sums);
      if (drift === null) return { drift: null, notice: false };
      strongRun = drift.strong ? strongRun + 1 : 0;
      const notice = strongRun >= T.driftConsecutiveWindows;
      if (notice) strongRun = 0;
      return { drift, notice };
    },
  };
}
