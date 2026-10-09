import type { KeyKind, createTypingAnalyzer } from './inputDetectors.js';

/** The slice of a KeyboardEvent the recorder reads. The key itself is never stored. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** `null` when the key should not count toward rhythm (IME, shortcuts, navigation keys). */
export function keyKind(e: KeyLike): KeyKind | null {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') {
    return null;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') return 'correction';
  if (e.ctrlKey || e.metaKey) return null;
  return e.key.length === 1 || e.key === 'Enter' ? 'char' : null;
}

/**
 * Pairs keydown with keyup (by physical key position, kept only in memory until
 * released) and feeds dwell + timing to a typing analyzer. Nothing about which
 * key was pressed reaches the analyzer: only the kind (character or correction).
 */
export function createKeyRecorder(
  analyzer: Pick<ReturnType<typeof createTypingAnalyzer>, 'record'>,
  now: () => number = () => performance.now(),
) {
  const down = new Map<string, { t: number; kind: KeyKind }>();
  return {
    keyDown(e: KeyLike): KeyKind | null {
      const kind = keyKind(e);
      if (kind === null || e.repeat) return kind;
      down.set(e.code || e.key, { t: now(), kind });
      return kind;
    },
    keyUp(e: Pick<KeyLike, 'key' | 'code'>): void {
      const id = e.code || e.key;
      const started = down.get(id);
      if (started === undefined) return;
      down.delete(id);
      analyzer.record(started.t, now() - started.t, started.kind);
    },
    clear(): void {
      down.clear();
    },
  };
}
