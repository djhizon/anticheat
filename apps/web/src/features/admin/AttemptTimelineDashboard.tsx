import { useEffect, useState } from 'react';
import type { InstructorAttemptSummary } from '@examguard/contracts/exam';

import { IntegrityTimeline } from '../integrity/IntegrityTimeline.js';
import { EvidenceGallery } from '../evidence/EvidenceGallery.js';
import type { EvidenceApi } from '../evidence/evidenceApi.js';
import type { InstructorTimelineApi } from './api.js';

/**
 * Instructor view of the unified integrity log for one student attempt. The
 * log is a set of leads to read in context, never an automatic verdict.
 */
export function AttemptTimelineDashboard({
  api,
  evidence,
}: {
  readonly api: InstructorTimelineApi;
  /** When provided, saved photos are shown inline in the log and as a gallery below it. */
  readonly evidence?: Pick<EvidenceApi, 'listEvidence' | 'loadEvidenceImage'> | undefined;
}) {
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
      {selected !== '' && (
        <PrivacySummary attempt={attempts?.find((attempt) => attempt.id === selected)} />
      )}
      {selected !== '' && (
        <IntegrityTimeline
          attemptId={selected}
          api={api}
          loadEvidenceImage={evidence?.loadEvidenceImage}
        />
      )}
      {selected !== '' && evidence !== undefined && (
        <EvidenceGallery
          attemptId={selected}
          listEvidence={evidence.listEvidence}
          loadImage={evidence.loadEvidenceImage}
          note="Still photos saved when local checks noticed something unusual. Treat them as leads for a conversation, not proof."
        />
      )}
    </section>
  );
}

/** Plain-language retention line for one exam-level setting. */
export function retentionLabel(days: number): string {
  return days === 0
    ? 'kept until the attempt is removed'
    : `deleted after ${days} day${days === 1 ? '' : 's'}`;
}

/** Read-only view of the exam's privacy settings for the selected attempt. */
function PrivacySummary({ attempt }: { readonly attempt: InstructorAttemptSummary | undefined }) {
  const privacy = attempt?.privacy;
  if (privacy === undefined) return null;
  const sameWindow = privacy.evidenceRetainDays === privacy.transcriptRetainDays;
  return (
    <p className="muted" data-testid="attempt-privacy">
      Privacy for this exam: photos{sameWindow ? ' and transcripts ' : ' '}
      {retentionLabel(privacy.evidenceRetainDays)}
      {sameWindow ? '' : `, transcripts ${retentionLabel(privacy.transcriptRetainDays)}`}
      {privacy.retainDays === null ? ' (server default)' : ''}; recordings{' '}
      {privacy.recordingUpload ? 'uploaded to OneDrive' : 'stay on the student’s computer'}.
      Attempts marked fine lose their photos, transcripts and recordings after 7 days.
    </p>
  );
}
