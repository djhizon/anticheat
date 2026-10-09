import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewDecisionValue, ReviewLevel } from '@examguard/contracts/findings';
import { REVIEW_LEVEL_LABELS } from '@examguard/contracts/findings';

import type { EvidenceApi } from '../evidence/evidenceApi.js';
import { EvidenceCard } from './EvidenceCard.js';
import type { RecordingSource } from './ClipPlayer.js';
import type { TriageApi, TriageAttemptRow } from './findingsApi.js';

const levelOrder: Readonly<Record<ReviewLevel, number>> = { review: 0, glance: 1, none: 2 };

/** review → glance → none (rows without a level last), newest first within a level. */
export function sortForTriage(rows: readonly TriageAttemptRow[]): TriageAttemptRow[] {
  return [...rows].sort((left, right) => {
    const a = left.level === undefined ? 3 : levelOrder[left.level];
    const b = right.level === undefined ? 3 : levelOrder[right.level];
    if (a !== b) return a - b;
    return right.startedAt.localeCompare(left.startedAt);
  });
}

export function levelCounts(rows: readonly TriageAttemptRow[]): Record<ReviewLevel, number> {
  const counts = { none: 0, glance: 0, review: 0 };
  for (const row of rows) if (row.level !== undefined) counts[row.level] += 1;
  return counts;
}

/** Next undecided attempt after `fromIndex` (wrapping), flagged ones first. */
export function nextNeedingReview(
  rows: readonly TriageAttemptRow[],
  fromIndex: number,
): number | null {
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => index !== fromIndex && !row.decision);
  const after = (list: typeof candidates) => list.find(({ index }) => index > fromIndex) ?? list[0];
  const flagged = after(
    candidates.filter(({ row }) => row.level === 'review' || row.level === 'glance'),
  );
  const pick = flagged ?? after(candidates);
  return pick === undefined ? null : pick.index;
}

const decisionLabel: Readonly<Record<ReviewDecisionValue, string>> = {
  fine: 'Fine',
  follow_up: 'Follow up',
};

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

/**
 * Instructor triage: counts, a list sorted by how much a look is needed, one evidence card
 * for the selected attempt and a two-button decision. Keyboard: F fine, U follow up, J/K next
 * and previous attempt. "Details" opens the full timeline, gallery and recordings.
 */
export function TriageDashboard({
  api,
  evidence,
  recordings,
  onDetails,
}: {
  readonly api: TriageApi;
  readonly evidence: Pick<EvidenceApi, 'listEvidence' | 'loadEvidenceImage'>;
  readonly recordings?: RecordingSource;
  readonly onDetails: (attemptId: string) => void;
}) {
  const [rows, setRows] = useState<readonly TriageAttemptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let active = true;
    api
      .listAttempts()
      .then((loaded) => {
        if (!active) return;
        const sorted = sortForTriage(loaded);
        setRows(sorted);
        setSelected(Math.max(0, nextNeedingReview(sorted, -1) ?? 0));
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Attempts could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [api]);

  const current = rows?.[selected];
  const counts = useMemo(() => (rows === null ? null : levelCounts(rows)), [rows]);

  const move = useCallback(
    (delta: number) => {
      if (rows === null || rows.length === 0) return;
      setSelected((index) => (index + delta + rows.length) % rows.length);
      setNote('');
      setSaveError(null);
    },
    [rows],
  );

  const decide = useCallback(
    async (decision: ReviewDecisionValue) => {
      if (rows === null || current === undefined || saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        const saved = await api.decide(
          current.id,
          note.trim() === '' ? { decision } : { decision, note: note.trim() },
        );
        const updated = rows.map((row) =>
          row.id === current.id ? { ...row, decision: saved } : row,
        );
        setRows(updated);
        setNote('');
        const next = nextNeedingReview(updated, selected);
        if (next !== null) setSelected(next);
        // Keep keyboard flow going: focus returns to the list, not the note field.
        listRef.current?.focus();
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : 'The decision could not be saved.');
      } finally {
        setSaving(false);
      }
    },
    [api, current, note, rows, saving, selected],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') void decide('fine');
      else if (key === 'u') void decide('follow_up');
      else if (key === 'j') move(1);
      else if (key === 'k') move(-1);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [decide, move]);

  return (
    <section className="admin-dashboard triage" aria-labelledby="triage-title">
      <h2 id="triage-title">Who needs a look</h2>
      <p className="muted">
        Findings are leads from the stored timeline, never verdicts. Decide with <kbd>F</kbd> fine
        or <kbd>U</kbd> follow up; <kbd>J</kbd>/<kbd>K</kbd> move between attempts.
      </p>
      {rows === null && error === null && <p role="status">Loading attempts…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {counts !== null && (
        <p className="triage-counts" role="status">
          {counts.none} no review · {counts.glance} glance · {counts.review} review
        </p>
      )}
      {rows !== null && rows.length === 0 && <p>No exam attempts yet.</p>}
      {rows !== null && rows.length > 0 && (
        <div className="triage-layout">
          <ol className="triage-list" aria-label="Attempts" ref={listRef} tabIndex={-1}>
            {rows.map((row, index) => (
              <li
                key={row.id}
                className={`triage-row${index === selected ? ' triage-row--selected' : ''}`}
                aria-current={index === selected ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="triage-row-button"
                  onClick={() => {
                    setSelected(index);
                    setNote('');
                    setSaveError(null);
                  }}
                >
                  <span className="triage-student" title={row.studentEmail}>
                    {row.studentEmail}
                  </span>
                  <span className={`level-chip level-chip--${row.level ?? 'unknown'}`}>
                    {row.level === undefined ? 'Not analysed' : REVIEW_LEVEL_LABELS[row.level]}
                  </span>
                  <span className="triage-reason">{row.topReason ?? '—'}</span>
                  <span className="triage-decision">
                    {row.decision ? `✓ ${decisionLabel[row.decision.decision]}` : 'Undecided'}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {current !== undefined && (
            <div className="triage-detail">
              <EvidenceCard
                key={current.id}
                attemptId={current.id}
                studentEmail={current.studentEmail}
                api={api}
                evidence={evidence}
                {...(recordings === undefined ? {} : { recordings })}
              />
              <form
                className="triage-decision"
                aria-label="Decision"
                onSubmit={(event) => {
                  event.preventDefault();
                  void decide('fine');
                }}
              >
                <label htmlFor="triage-note">Note (optional)</label>
                <input
                  id="triage-note"
                  ref={noteRef}
                  type="text"
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. Ask about the second voice"
                />
                <div className="triage-buttons">
                  <button
                    type="button"
                    className="submit-button"
                    disabled={saving}
                    onClick={() => void decide('fine')}
                  >
                    Fine <kbd>F</kbd>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => void decide('follow_up')}
                  >
                    Follow up <kbd>U</kbd>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onDetails(current.id)}
                  >
                    Details
                  </button>
                </div>
                {current.decision && (
                  <p className="muted" role="status">
                    Decided: {decisionLabel[current.decision.decision]}
                    {current.decision.note ? ` — ${current.decision.note}` : ''} (
                    {new Date(current.decision.decidedAt).toLocaleString()})
                  </p>
                )}
                {saveError !== null && <p role="alert">{saveError}</p>}
              </form>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
