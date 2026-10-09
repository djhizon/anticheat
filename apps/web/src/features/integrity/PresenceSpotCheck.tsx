import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TYPING_QUIET_MS,
  createBoundaryScheduler,
  presenceScheduleFromEnv,
  type PresenceScheduleConfig,
} from './presenceSchedule.js';

/** How long the note stays (fading) after a pass. */
export const PASSED_VISIBLE_MS = 1500;

/** One spot check: the edge colour pulse and its server verification. */
export type SpotCheckResult = 'passed' | 'failed' | 'unavailable';
export type SpotCheckRunner = (signal: AbortSignal) => Promise<SpotCheckResult>;

type Phase = 'idle' | 'checking' | 'passed';

function defaultConfig(): PresenceScheduleConfig {
  try {
    return presenceScheduleFromEnv(import.meta.env as unknown as Record<string, unknown>);
  } catch {
    return presenceScheduleFromEnv({});
  }
}

export interface PresenceSpotChecks {
  readonly phase: Phase;
  /** Call right after an item was answered or the student moved to another question. */
  readonly itemBoundary: (answered: boolean) => void;
}

/**
 * Drives the mid-exam presence spot checks. Never student-triggered: checks start only at item
 * boundaries (see presenceSchedule.ts), never mid-typing and never while answering is paused.
 * A pass is logged by the server (verified); a miss is retried silently at the next boundary and
 * only a second miss is reported (`presence_check_failed`, non-accusatory).
 */
export function usePresenceSpotChecks(options: {
  readonly active: boolean;
  readonly paused: boolean;
  readonly run: SpotCheckRunner;
  readonly reportFailed: () => void;
  /** Milliseconds since the last key press (Infinity when none). */
  readonly sinceLastKey: () => number;
  readonly config?: PresenceScheduleConfig;
  readonly random?: () => number;
  readonly now?: () => number;
}): PresenceSpotChecks {
  const { active, paused, config, random, now } = options;
  const [phase, setPhase] = useState<Phase>('idle');
  const scheduler = useMemo(
    () =>
      createBoundaryScheduler({
        config: config ?? defaultConfig(),
        ...(random ? { random } : {}),
        ...(now ? { now } : {}),
      }),
    // A fresh schedule per active attempt.
    [active],
  );
  const latest = useRef(options);
  latest.current = options;
  const running = useRef<AbortController | null>(null);
  const failedOnce = useRef(false);
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      running.current?.abort();
      if (fade.current !== undefined) clearTimeout(fade.current);
    },
    [],
  );
  // Answering paused (camera gate, screen recording): abandon a check in progress.
  useEffect(() => {
    if (paused || !active) {
      running.current?.abort();
      running.current = null;
      setPhase('idle');
    }
  }, [paused, active]);

  const itemBoundary = useCallback(
    (answered: boolean) => {
      const current = latest.current;
      if (!current.active || current.paused || running.current !== null) {
        if (answered) scheduler.boundary(true);
        return;
      }
      if (!scheduler.boundary(answered)) return;
      if (current.sinceLastKey() < TYPING_QUIET_MS) return; // never mid-typing
      const controller = new AbortController();
      running.current = controller;
      if (fade.current !== undefined) clearTimeout(fade.current);
      setPhase('checking');
      void current
        .run(controller.signal)
        .catch((): SpotCheckResult => 'unavailable')
        .then((result) => {
          if (controller.signal.aborted) return;
          running.current = null;
          if (result === 'passed') {
            failedOnce.current = false;
            scheduler.completed();
            setPhase('passed');
            fade.current = setTimeout(() => setPhase('idle'), PASSED_VISIBLE_MS);
            return;
          }
          setPhase('idle');
          if (result === 'unavailable') return; // no verdict: the next boundary tries again
          if (!failedOnce.current) {
            failedOnce.current = true;
            scheduler.retryNext();
            return;
          }
          failedOnce.current = false;
          scheduler.completed();
          latest.current.reportFailed();
        });
    },
    [scheduler],
  );

  return { phase, itemBoundary };
}

/** The tiny corner note. No buttons, no focus change, announced politely. */
export function PresenceNote({ phase }: { readonly phase: Phase }) {
  if (phase === 'idle') return null;
  return (
    <aside
      className={`presence-card${phase === 'passed' ? ' presence-card--done' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Quick presence check"
    >
      <p className="presence-card-title">
        {phase === 'checking' ? 'Quick presence check…' : 'Quick presence check ✓'}
      </p>
    </aside>
  );
}
