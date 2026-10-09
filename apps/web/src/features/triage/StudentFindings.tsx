import { useEffect, useState } from 'react';
import type { AttemptFindings, Finding } from '@examguard/contracts/findings';
import { FINDING_NOTE_MAX } from '@examguard/contracts/findings';

import { confidenceLabel } from './EvidenceCard.js';
import { windowLabel } from './ClipPlayer.js';
import type { FindingNotesApi } from './findingsApi.js';

/**
 * Student-facing view of the same findings the instructor triages, in plain language, with a
 * short note box per finding so the student can explain before anyone asks.
 */
export function StudentFindings({
  attemptId,
  api,
}: {
  readonly attemptId: string;
  readonly api: FindingNotesApi;
}) {
  const [findings, setFindings] = useState<AttemptFindings | null | 'loading' | 'failed'>(
    'loading',
  );

  useEffect(() => {
    let active = true;
    setFindings('loading');
    api
      .getFindings(attemptId)
      .then((loaded) => {
        if (active) setFindings(loaded);
      })
      .catch(() => {
        if (active) setFindings('failed');
      });
    return () => {
      active = false;
    };
  }, [attemptId, api]);

  return (
    <section className="student-findings" aria-labelledby="student-findings-title">
      <h3 id="student-findings-title">What your teacher may look at</h3>
      <p className="transparency-note">
        A few moments from your attempt are summarised below exactly as your teacher sees them. They
        are leads for a conversation, not accusations. You can add a short note to any of them.
      </p>
      {findings === 'loading' && <p role="status">Loading…</p>}
      {findings === 'failed' && <p role="alert">This summary could not be loaded right now.</p>}
      {findings === null && <p className="muted">Findings not available yet.</p>}
      {typeof findings === 'object' && findings !== null && findings.findings.length === 0 && (
        <p className="transparency-empty">✅ Nothing stood out in your attempt.</p>
      )}
      {typeof findings === 'object' && findings !== null && findings.findings.length > 0 && (
        <ol className="finding-list">
          {findings.findings.map((finding) => (
            <FindingWithNote key={finding.id} attemptId={attemptId} finding={finding} api={api} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FindingWithNote({
  attemptId,
  finding,
  api,
}: {
  readonly attemptId: string;
  readonly finding: Finding;
  readonly api: FindingNotesApi;
}) {
  const [note, setNote] = useState(finding.studentNote ?? '');
  const [saved, setSaved] = useState<string | null>(finding.studentNote);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const noteId = `finding-note-${finding.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`;

  async function save(): Promise<void> {
    setState('saving');
    try {
      await api.saveNote(attemptId, finding.id, note);
      setSaved(note.trim() === '' ? null : note);
      setState('saved');
    } catch {
      setState('failed');
    }
  }

  return (
    <li className="finding">
      <header>
        <strong>{finding.title}</strong>{' '}
        <span className={`confidence-chip confidence-chip--${finding.confidence}`}>
          {confidenceLabel[finding.confidence]}
        </span>
      </header>
      <ul className="finding-reasons">
        {finding.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {finding.windows.length > 0 && (
        <p className="muted">When: {finding.windows.map(windowLabel).join('; ')}</p>
      )}
      <form
        className="finding-note-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={noteId}>Your note (optional)</label>
        <textarea
          id={noteId}
          maxLength={FINDING_NOTE_MAX}
          rows={2}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            if (state !== 'idle') setState('idle');
          }}
          placeholder="e.g. My brother walked in to ask something; I sent him away."
        />
        <div className="finding-note-actions">
          <small>
            {note.length}/{FINDING_NOTE_MAX}
          </small>
          <button
            type="submit"
            className="secondary-button"
            disabled={state === 'saving' || note === (saved ?? '')}
          >
            {state === 'saving' ? 'Saving…' : 'Save note'}
          </button>
          {state === 'saved' && <span role="status">Saved ✓</span>}
          {state === 'failed' && <span role="alert">Your note was not saved. Try again.</span>}
        </div>
      </form>
    </li>
  );
}
