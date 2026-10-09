import { useEffect, useSyncExternalStore } from 'react';

/** What the Electron main process reports for `display:boost-brightness`. */
export interface BrightnessReply {
  readonly status: 'boosted' | 'unsupported';
  /** True when the app puts the brightness back if the student lowers it (Strict mode). */
  readonly enforcing: boolean;
}

export interface DesktopBrightnessBridge {
  boostBrightness(attemptId: string): Promise<unknown>;
  restoreBrightness(): Promise<unknown>;
}

export type BrightnessState =
  | { readonly kind: 'browser' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'boosted'; readonly enforcing: boolean }
  | { readonly kind: 'unsupported' };

export function desktopBrightnessBridge(): DesktopBrightnessBridge | undefined {
  const bridge = (window as Window & { electronExam?: Partial<DesktopBrightnessBridge> })
    .electronExam;
  return bridge?.boostBrightness && bridge.restoreBrightness
    ? (bridge as DesktopBrightnessBridge)
    : undefined;
}

export function parseBrightnessReply(value: unknown): BrightnessReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const { status, enforcing } = value as Record<string, unknown>;
  if (status !== 'boosted' && status !== 'unsupported') return null;
  return { status, enforcing: enforcing === true };
}

/** Plain-language note shown next to the lighting controls. */
export function brightnessTip(state: BrightnessState): string {
  switch (state.kind) {
    case 'browser':
      return 'Browsers cannot change your screen brightness. For the best face tracking, turn your screen brightness up to maximum yourself.';
    case 'unsupported':
      return 'This app could not change your screen brightness (for example, an external display). Please turn your screen brightness up to maximum yourself.';
    case 'boosted':
      return state.enforcing
        ? 'Screen brightness was set to maximum for this exam and will be restored afterwards. Lowering it will be undone.'
        : 'Screen brightness was set to maximum for this exam and will be restored afterwards.';
    case 'pending':
      return '';
  }
}

let state: BrightnessState = { kind: 'browser' };
const listeners = new Set<() => void>();

function publish(next: BrightnessState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useBrightnessState(): BrightnessState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/**
 * While an attempt is in progress, ask the desktop shell to raise the built-in display to full
 * brightness and restore it on exit. A no-op in a browser, which cannot change brightness.
 */
export function useExamBrightness(attemptId: string | null): void {
  useEffect(() => {
    const bridge = desktopBrightnessBridge();
    if (!bridge) {
      publish({ kind: 'browser' });
      return;
    }
    if (attemptId === null) return;
    let live = true;
    publish({ kind: 'pending' });
    void bridge
      .boostBrightness(attemptId)
      .then((value) => {
        if (!live) return;
        const reply = parseBrightnessReply(value);
        publish(
          reply?.status === 'boosted'
            ? { kind: 'boosted', enforcing: reply.enforcing }
            : { kind: 'unsupported' },
        );
      })
      .catch(() => {
        if (live) publish({ kind: 'unsupported' });
      });
    return () => {
      live = false;
      void bridge.restoreBrightness().catch(() => {});
    };
  }, [attemptId]);
}
