import { useEffect, useState } from 'react';
import type { InstructorAttemptSummary } from '@exam-anti-cheat/contracts/exam';

import { IntegrityTimeline } from '../integrity/IntegrityTimeline.js';
import type { InstructorTimelineApi } from './api.js';

/**
 * Instructor view of the unified integrity log for one student attempt. The
 * log is a set of leads to read in context, never an automatic verdict.
 */
export function AttemptTimelineDashboard({ api }: { readonly api: InstructorTimelineApi }) {
  const [attempts, setAttempts] = useState<readonly InstructorAttemptSummary[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listAttempts()
      .then((loaded) => {
        if (active) setAttempts(loaded);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Attempts could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <section className="admin-dashboard" aria-labelledby="attempt-timeline-title">
      <h2 id="attempt-timeline-title">🕒 Attempt integrity log</h2>
      <p className="muted">
        One chronological log per student attempt combining every monitoring signal. Entries are
        leads for review, not verdicts.
      </p>
      {attempts === null && error === null && <p role="status">Loading attempts…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {attempts !== null && attempts.length === 0 && <p>No exam attempts yet.</p>}
      {attempts !== null && attempts.length > 0 && (
        <div className="similarity-controls">
          <label htmlFor="attempt-timeline-select">Student attempt</label>
          <select
            id="attempt-timeline-select"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose an attempt…</option>
            {attempts.map((attempt) => (
              <option key={attempt.id} value={attempt.id}>
                {attempt.studentEmail} — {attempt.examTitle} ({attempt.status.replace('_', ' ')},{' '}
                {new Date(attempt.startedAt).toLocaleString()})
              </option>
            ))}
          </select>
        </div>
      )}
      {selected !== '' && <IntegrityTimeline attemptId={selected} api={api} />}
    </section>
  );
}
