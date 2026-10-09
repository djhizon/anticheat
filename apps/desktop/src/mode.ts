export type RunMode = 'demo' | 'strict';

export function isRunMode(value: unknown): value is RunMode {
  return value === 'demo' || value === 'strict';
}

/**
 * Build default: the packaged judge build starts in Demo so judges can try it without anything
 * being closed; every other build starts Strict. Demo is only ever an explicit choice (this
 * build default or a persisted user choice), never a fallback for missing/corrupt state.
 */
export function defaultRunMode(judgeBuild: boolean): RunMode {
  return judgeBuild ? 'demo' : 'strict';
}

/** True only when the packaged app metadata explicitly marks the judge build. */
export function isJudgeBuildMetadata(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const value: unknown = JSON.parse(raw);
    return (
      typeof value === 'object' &&
      value !== null &&
      'examJudgeBuild' in value &&
      value.examJudgeBuild === true
    );
  } catch {
    return false;
  }
}

/** Parse the persisted settings file; anything unexpected falls back to the build default. */
export function parseRunMode(raw: unknown, fallback: RunMode): RunMode {
  if (typeof raw !== 'string') return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'mode' in value && isRunMode(value.mode))
      return value.mode;
  } catch {
    /* Corrupt settings must not block the app. */
  }
  return fallback;
}

export interface ModeSwitchPlan {
  /** False when the requested mode is already active. */
  change: boolean;
  /** True when the user must explicitly confirm before the switch (either direction). */
  confirm: boolean;
}

/**
 * Strict can quit other apps and blocks on findings; Demo disables every protection. Both
 * directions need an explicit confirmation.
 */
export function planModeSwitch(current: RunMode, target: RunMode): ModeSwitchPlan {
  if (current === target) return { change: false, confirm: false };
  return { change: true, confirm: true };
}

/** Demo mode never quits any application. */
export function mayCloseApps(mode: RunMode): boolean {
  return mode === 'strict';
}
