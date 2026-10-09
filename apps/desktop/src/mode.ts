export type RunMode = 'demo' | 'strict';

export const DEFAULT_RUN_MODE: RunMode = 'demo';

export function isRunMode(value: unknown): value is RunMode {
  return value === 'demo' || value === 'strict';
}

/** Parse the persisted settings file; anything unexpected falls back to the default. */
export function parseRunMode(raw: unknown): RunMode {
  if (typeof raw !== 'string') return DEFAULT_RUN_MODE;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'mode' in value && isRunMode(value.mode))
      return value.mode;
  } catch {
    /* Corrupt settings must not block the app. */
  }
  return DEFAULT_RUN_MODE;
}

export interface ModeSwitchPlan {
  /** False when the requested mode is already active. */
  change: boolean;
  /** True when the user must explicitly confirm before the switch. */
  confirm: boolean;
}

/** Switching to strict (which can quit other apps and blocks on findings) needs confirmation. */
export function planModeSwitch(current: RunMode, target: RunMode): ModeSwitchPlan {
  if (current === target) return { change: false, confirm: false };
  return { change: true, confirm: target === 'strict' };
}

/** Demo mode never quits any application. */
export function mayCloseApps(mode: RunMode): boolean {
  return mode === 'strict';
}
