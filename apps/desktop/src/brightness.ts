import type { RunMode } from './mode';

/** One reading from the native helper. `brightness` is 0..1 and null when unsupported. */
export interface BrightnessReading {
  supported: boolean;
  brightness: number | null;
}

/** Reads and sets the built-in display level. Implemented by the Swift helper; faked in tests. */
export interface BrightnessHelper {
  get(): Promise<BrightnessReading>;
  set(level: number): Promise<BrightnessReading>;
}

/** Persists the pre-exam level so a crash can be undone on the next launch. */
export interface OriginalStore {
  read(): number | null;
  write(level: number): void;
  clear(): void;
}

export interface BrightnessReply {
  status: 'boosted' | 'unsupported';
  /** True when the level is put back if the student lowers it (Strict mode only). */
  enforcing: boolean;
}

export interface TimerApi {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BrightnessDeps {
  helper: BrightnessHelper;
  store: OriginalStore;
  getMode: () => RunMode;
  /** Called (rate-limited) when the student lowered brightness and it was restored. */
  onRestored: (attemptId: string) => void;
  log?: (event: string, detail?: string) => void;
  now?: () => number;
  timers?: TimerApi;
}

export const BOOST_LEVEL = 1;
export const ENFORCE_INTERVAL_MS = 3000;
/** The student lowering brightness is logged at most this often. */
export const RESTORE_LOG_INTERVAL_MS = 30_000;
/** Below this, the level counts as lowered. */
const LOWERED_BELOW = 0.97;

const realTimers: TimerApi = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

interface Active {
  original: number;
  attemptId: string;
  enforcing: boolean;
  timer: unknown;
}

/**
 * Brightness enforcement state machine.
 *
 * idle -> boost() remembers the level, persists it, and sets 100%. Strict then polls every 3 s and
 * sets 100% again if it was lowered; Demo sets once and never fights the student. restore() (exam
 * end, window close, app quit) puts the original back. recover() undoes a crash on next launch.
 * Every helper failure degrades to "unsupported": brightness must never block or break an exam.
 */
export function createBrightnessController(deps: BrightnessDeps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;
  const log = deps.log ?? (() => {});
  let active: Active | null = null;
  let lastRestoreLog = -Infinity;
  let polling = false;
  // Helper calls are strictly serialised: a restore can never interleave with a boost or poll.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  };

  const safe = async (call: () => Promise<BrightnessReading>): Promise<BrightnessReading> => {
    try {
      return await call();
    } catch {
      return { supported: false, brightness: null };
    }
  };

  async function enforceOnce(state: Active): Promise<void> {
    if (active !== state || deps.getMode() !== 'strict') return;
    const reading = await safe(() => deps.helper.get());
    if (!reading.supported || reading.brightness === null) return;
    if (reading.brightness >= LOWERED_BELOW) return;
    await safe(() => deps.helper.set(BOOST_LEVEL));
    const at = now();
    if (at - lastRestoreLog >= RESTORE_LOG_INTERVAL_MS) {
      lastRestoreLog = at;
      deps.onRestored(state.attemptId);
    }
  }

  function poll(state: Active): void {
    if (polling || active !== state) return;
    polling = true;
    void enqueue(() => enforceOnce(state)).finally(() => {
      polling = false;
    });
  }

  const stopTimer = (state: Active | null): void => {
    if (state?.timer !== undefined && state.timer !== null) timers.clearInterval(state.timer);
  };

  return {
    isActive: (): boolean => active !== null,

    boost(attemptId: string): Promise<BrightnessReply> {
      return enqueue(async () => {
        if (active) {
          active.attemptId = attemptId;
          return { status: 'boosted', enforcing: active.enforcing } as BrightnessReply;
        }
        const unsupported: BrightnessReply = { status: 'unsupported', enforcing: false };
        const before = await safe(() => deps.helper.get());
        if (!before.supported || before.brightness === null) return unsupported;
        const original = before.brightness;
        // Persist first: if the app dies after the next line, the next launch restores this level.
        try {
          deps.store.write(original);
        } catch {
          log('brightness-persist-failed');
        }
        const after = await safe(() => deps.helper.set(BOOST_LEVEL));
        if (!after.supported || after.brightness === null || after.brightness < LOWERED_BELOW) {
          await safe(() => deps.helper.set(original));
          deps.store.clear();
          return unsupported;
        }
        const enforcing = deps.getMode() === 'strict';
        const state: Active = { original, attemptId, enforcing, timer: null };
        active = state;
        if (enforcing) state.timer = timers.setInterval(() => poll(state), ENFORCE_INTERVAL_MS);
        log('brightness-boosted', enforcing ? 'strict' : 'demo');
        return { status: 'boosted', enforcing } as BrightnessReply;
      });
    },

    /** Exam end, window close or quit: put the remembered level back. Idempotent. */
    restore(): Promise<void> {
      return enqueue(async () => {
        const state = active;
        active = null;
        stopTimer(state);
        if (!state) return;
        await safe(() => deps.helper.set(state.original));
        deps.store.clear();
        log('brightness-restored-on-exit');
      });
    },

    /** Next launch after a crash: if a level was left behind, put it back. */
    recover(): Promise<void> {
      return enqueue(async () => {
        if (active) return;
        let original: number | null = null;
        try {
          original = deps.store.read();
        } catch {
          original = null;
        }
        if (original === null) return;
        const reading = await safe(() => deps.helper.set(original));
        // Keep the record if the helper was unavailable so a later launch can retry.
        if (reading.supported) deps.store.clear();
        log('brightness-crash-recovered', reading.supported ? 'ok' : 'unavailable');
      });
    },
  };
}
