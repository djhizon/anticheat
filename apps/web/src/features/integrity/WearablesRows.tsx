import type { SignalState, WearableSignal } from './wearablesCore.js';
import type { WearablesSnapshot } from './wearablesEngine.js';

const ROWS: readonly { signal: WearableSignal; label: string; seen: string }[] = [
  { signal: 'earbuds', label: 'Earbuds', seen: 'Possibly detected' },
  { signal: 'headphones', label: 'Headphones', seen: 'Possibly detected' },
  // Glasses are ordinary: say so plainly, and never suggest they are a problem.
  { signal: 'glasses', label: 'Glasses', seen: 'Worn (normal, information only)' },
  { signal: 'watch', label: 'Watch', seen: 'Visible (information only)' },
];

/** Extra rows shown only for the detailed (desktop app) model. */
const DETAILED_ROWS: readonly { signal: WearableSignal; label: string; seen: string }[] = [
  { signal: 'notes', label: 'Paper notes', seen: 'Possibly in view' },
  { signal: 'extra_person', label: 'Another person', seen: 'Possibly in view' },
];

function value(snapshot: WearablesSnapshot, state: SignalState, seen: string): string {
  if (snapshot.status === 'unavailable') return 'Detector unavailable';
  if (snapshot.status !== 'running' || state.runs === 0) return 'Checking…';
  if (!state.confirmed) return 'Not observed';
  const percent = state.confidence === null ? '' : ` (${Math.round(state.confidence * 100)}%)`;
  return `${seen}${percent}`;
}

export function wearablesSourceText(snapshot: WearablesSnapshot): string {
  if (snapshot.status === 'off') return '';
  if (snapshot.status === 'loading') return 'Loading the on-device accessory check…';
  if (snapshot.status === 'unavailable') {
    return 'On-device accessory check unavailable (run vision:prepare); not treated as a clear result.';
  }
  const where = snapshot.backend === 'local' ? 'desktop app, on this device' : 'in this browser';
  const timing = snapshot.inferenceMs === null ? '' : ` · ${snapshot.inferenceMs} ms per check`;
  return `Accessory check: ${snapshot.model ?? 'model'} (${where})${timing}. A lead only, never proof.`;
}

/** The accessory rows of the camera panel (replaces the old "not available" rows). */
export function WearablesRows({ snapshot }: { readonly snapshot: WearablesSnapshot }) {
  if (snapshot.status === 'off') return null;
  const rows = snapshot.backend === 'local' ? [...ROWS, ...DETAILED_ROWS] : ROWS;
  return (
    <>
      {rows.map(({ signal, label, seen }) => (
        <p key={signal}>
          {label}: {value(snapshot, snapshot.signals[signal], seen)}
        </p>
      ))}
      <p className="muted">{wearablesSourceText(snapshot)}</p>
    </>
  );
}
