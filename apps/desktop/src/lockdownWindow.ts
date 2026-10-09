import type { RunMode } from './mode';

/**
 * Exam-window lockdown. Active only while an exam attempt is in progress (entered from the
 * `start-watcher` IPC, left on `stop-watcher`, emergency exit, or app quit).
 *
 * Strict: kiosk presentation options + fullscreen + always-on-top, and every attempt to leave
 * (minimize, hide, leave fullscreen, lose focus) is undone within ~300 ms and recorded.
 * Demo: fullscreen with minimize/close disabled and blur/minimize recorded, but no kiosk and no
 * forced refocus, and Esc ends the lockdown immediately so a judge is never trapped.
 *
 * This is a deterrent, not a security boundary: macOS gestures such as Mission Control, a
 * Force Quit from another session, or switching users cannot be fully blocked by an app.
 *
 * Everything Electron-specific is injected so the logic is unit-testable.
 */

export type LockdownEventName =
  'window_minimize_blocked' | 'fullscreen_exit_blocked' | 'focus_lost' | 'lockdown_emergency_exit';

type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LockdownWebContents {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
  send(channel: string, ...args: unknown[]): void;
}

export interface LockdownBrowserWindow {
  webContents: LockdownWebContents;
  isDestroyed(): boolean;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
  setKiosk(flag: boolean): void;
  isKiosk(): boolean;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver' | 'normal'): void;
  setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setMinimizable(flag: boolean): void;
  setClosable(flag: boolean): void;
  setMovable(flag: boolean): void;
  setResizable(flag: boolean): void;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  isFocused(): boolean;
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MenuItemTemplate {
  label?: string;
  role?: string;
  accelerator?: string;
  visible?: boolean;
  click?: () => void;
  submenu?: MenuItemTemplate[];
}

export interface LockdownDeps {
  getWindow(): LockdownBrowserWindow | null;
  getMode(): RunMode;
  /** Primary display bounds, so the exam window never ends up on a secondary display. */
  getPrimaryBounds(): Rect;
  /** Show a locked-down application menu. */
  setLockedMenu(template: MenuItemTemplate[]): void;
  /** Rebuild the normal application menu. */
  restoreMenu(): void;
  /** Ask the student to confirm the emergency exit; resolves true to proceed. */
  confirmEmergencyExit(window: LockdownBrowserWindow): Promise<boolean>;
  /** Application emitter ('browser-window-blur', 'did-resign-active', 'before-quit'). */
  app: {
    on(event: string, listener: Listener): unknown;
    removeListener(event: string, listener: Listener): unknown;
  };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  /** Fixed-category diagnostics only. */
  log?: (event: string) => void;
}

export interface InputLike {
  type?: string;
  key?: string;
  meta?: boolean;
  alt?: boolean;
  control?: boolean;
  shift?: boolean;
}

export const LOCKDOWN_EVENT_CHANNEL = 'lockdown-event';
export const RESTORE_DEBOUNCE_MS = 300;
const EVENT_MIN_GAP_MS = 2000;

type Violation = 'minimize' | 'hide' | 'leave-full-screen' | 'blur';

const EVENT_FOR: Record<Violation, LockdownEventName> = {
  minimize: 'window_minimize_blocked',
  hide: 'window_minimize_blocked',
  'leave-full-screen': 'fullscreen_exit_blocked',
  blur: 'focus_lost',
};

/** Shortcuts that would minimize, hide, close, quit, open windows, reload, or open devtools. */
export function isBlockedShortcut(input: InputLike, mode: RunMode): boolean {
  if (input.type !== 'keyDown') return false;
  const key = (input.key ?? '').toLowerCase();
  const meta = input.meta === true;
  const alt = input.alt === true;
  const control = input.control === true;
  const shift = input.shift === true;
  // Minimize and hide are no-ops in both modes (minimize is disabled), so swallow them early.
  if (meta && !control && (key === 'm' || key === 'h')) return true;
  if (mode !== 'strict') return false;
  if (meta && !control && !alt && ['w', 'q', 'n', 't', 'r'].includes(key)) return true;
  if (meta && alt && (key === 'i' || key === 'j' || key === 'c')) return true; // devtools
  if (key === 'f12') return true;
  if (meta && control && key === 'f') return true; // toggle full screen
  if (meta && shift && key === 'i') return true;
  return false;
}

export function isEmergencyShortcut(input: InputLike): boolean {
  return (
    input.type === 'keyDown' &&
    (input.key ?? '').toLowerCase() === 'q' &&
    input.meta === true &&
    input.shift === true &&
    input.control !== true &&
    input.alt !== true
  );
}

export interface LockdownController {
  /** Idempotent for the same attempt. Does nothing after an emergency exit for that attempt. */
  enter(attemptId: string): void;
  exit(): void;
  isActive(): boolean;
  /** Emergency exit (confirm in strict, immediate in demo). Resolves true if lockdown ended. */
  emergencyExit(): Promise<boolean>;
}

export function createLockdown(deps: LockdownDeps): LockdownController {
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;

  let active = false;
  let mode: RunMode = 'strict';
  let attemptId: string | null = null;
  let releasedAttempt: string | null = null;
  let win: LockdownBrowserWindow | null = null;
  let pending = new Set<Violation>();
  let timer: unknown = null;
  let confirming = false;
  const lastSent = new Map<LockdownEventName, number>();
  let cleanups: Array<() => void> = [];

  const alive = (w: LockdownBrowserWindow | null): w is LockdownBrowserWindow =>
    w !== null && !w.isDestroyed();

  function emit(event: LockdownEventName, force = false): void {
    if (!alive(win) || attemptId === null) return;
    const at = now();
    const last = lastSent.get(event);
    if (!force && last !== undefined && at - last < EVENT_MIN_GAP_MS) return;
    lastSent.set(event, at);
    win.webContents.send(LOCKDOWN_EVENT_CHANNEL, { attemptId, event });
  }

  function onPrimary(w: LockdownBrowserWindow): boolean {
    const b = w.getBounds();
    const p = deps.getPrimaryBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height;
  }

  function moveToPrimary(w: LockdownBrowserWindow): void {
    if (onPrimary(w)) return;
    const wasFull = w.isFullScreen();
    if (wasFull) w.setFullScreen(false);
    w.setBounds(deps.getPrimaryBounds());
    if (wasFull) w.setFullScreen(true);
  }

  /** Put the window back into the locked state (idempotent). */
  function reassert(w: LockdownBrowserWindow, refocus: boolean): void {
    if (w.isMinimized()) w.restore();
    w.show();
    moveToPrimary(w);
    if (!w.isFullScreen()) w.setFullScreen(true);
    if (mode === 'strict') {
      if (!w.isKiosk()) w.setKiosk(true);
      w.setAlwaysOnTop(true, 'screen-saver');
    }
    if (refocus) w.focus();
  }

  function flush(): void {
    timer = null;
    const violations = pending;
    pending = new Set();
    if (!active || !alive(win) || confirming) return;
    for (const v of violations) emit(EVENT_FOR[v]);
    // Demo records loss of focus but never steals focus back.
    const refocus = mode === 'strict' || [...violations].some((v) => v !== 'blur');
    try {
      reassert(win, refocus);
    } catch {
      deps.log?.('lockdown-reassert-failed');
    }
  }

  function violation(kind: Violation): void {
    if (!active || confirming) return;
    pending.add(kind);
    if (timer === null) timer = schedule(flush, RESTORE_DEBOUNCE_MS);
  }

  function lockedMenu(): MenuItemTemplate[] {
    return [
      {
        label: 'Exam Anti-Cheat',
        // Hidden emergency exit; no Quit, Hide or Minimize items while locked.
        submenu: [
          {
            label: 'Emergency exit',
            accelerator: 'CommandOrControl+Shift+Q',
            visible: false,
            click: () => void controller.emergencyExit(),
          },
        ],
      },
      {
        label: 'Edit',
        submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
    ];
  }

  function enter(id: string): void {
    try {
      applyEnter(id);
    } catch {
      // A window that cannot be locked must not break the exam; undo whatever was applied.
      deps.log?.('lockdown-enter-failed');
      exit();
    }
  }

  function applyEnter(id: string): void {
    const w = deps.getWindow();
    if (!alive(w)) return;
    if (releasedAttempt === id) return; // Student ended lockdown for this attempt.
    if (active && win === w) {
      attemptId = id;
      return;
    }
    if (active) exit();
    win = w;
    attemptId = id;
    mode = deps.getMode();
    active = true;
    pending = new Set();
    lastSent.clear();

    // Go fullscreen first; some macOS versions refuse fullscreen on a non-resizable window.
    moveToPrimary(w);
    w.setFullScreen(true);
    if (mode === 'strict') {
      w.setKiosk(true);
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    w.setMinimizable(false);
    w.setClosable(false);
    w.setMovable(false);
    w.setResizable(false);
    deps.setLockedMenu(lockedMenu());

    const wire = (
      target: {
        on(e: string, l: Listener): unknown;
        removeListener(e: string, l: Listener): unknown;
      },
      event: string,
      listener: Listener,
    ): void => {
      target.on(event, listener);
      cleanups.push(() => target.removeListener(event, listener));
    };

    wire(w, 'close', (event: { preventDefault(): void }) => {
      if (active) event.preventDefault();
    });
    wire(w, 'minimize', () => violation('minimize'));
    wire(w, 'hide', () => violation('hide'));
    wire(w, 'leave-full-screen', () => violation('leave-full-screen'));
    wire(w, 'blur', () => violation('blur'));
    wire(deps.app, 'browser-window-blur', () => violation('blur'));
    wire(deps.app, 'did-resign-active', () => violation('blur'));
    wire(deps.app, 'before-quit', () => exit());
    wire(
      w.webContents,
      'before-input-event',
      (event: { preventDefault(): void }, input: InputLike) => {
        if (!active) return;
        if (isEmergencyShortcut(input)) {
          event.preventDefault();
          void controller.emergencyExit();
          return;
        }
        if (mode === 'demo' && input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault();
          void controller.emergencyExit();
          return;
        }
        if (isBlockedShortcut(input, mode)) {
          event.preventDefault();
          if (input.key?.toLowerCase() === 'm' || input.key?.toLowerCase() === 'h') {
            emit('window_minimize_blocked');
          }
        }
      },
    );
  }

  function exit(): void {
    if (!active) return;
    active = false;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    pending = new Set();
    for (const undo of cleanups) {
      try {
        undo();
      } catch {
        /* Window may already be gone. */
      }
    }
    cleanups = [];
    const w = win;
    win = null;
    attemptId = null;
    if (alive(w)) {
      // Undo in reverse order of entry; keep going if one step fails.
      const steps: Array<() => void> = [
        () => w.setAlwaysOnTop(false),
        () => w.setVisibleOnAllWorkspaces(false),
        () => w.setResizable(true),
        () => w.setMovable(true),
        () => w.setClosable(true),
        () => w.setMinimizable(true),
        () => w.setKiosk(false),
        () => w.setFullScreen(false),
      ];
      for (const step of steps) {
        try {
          step();
        } catch {
          deps.log?.('lockdown-restore-step-failed');
        }
      }
    }
    try {
      deps.restoreMenu();
    } catch {
      deps.log?.('lockdown-menu-restore-failed');
    }
  }

  async function emergencyExit(): Promise<boolean> {
    const w = win;
    if (!active || !alive(w) || confirming) return false;
    if (mode === 'strict') {
      confirming = true;
      let ok = false;
      try {
        ok = await deps.confirmEmergencyExit(w);
      } catch {
        ok = false;
      } finally {
        confirming = false;
      }
      if (!ok || !active || !alive(w)) {
        // The dialog itself may have moved focus; put things back.
        if (active && alive(w)) {
          try {
            reassert(w, true);
          } catch {
            /* best effort */
          }
        }
        return false;
      }
    }
    emit('lockdown_emergency_exit', true);
    releasedAttempt = attemptId;
    exit();
    return true;
  }

  const controller: LockdownController = {
    enter,
    exit,
    isActive: () => active,
    emergencyExit,
  };
  return controller;
}
