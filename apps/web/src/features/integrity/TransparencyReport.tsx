import { useEffect, useState } from 'react';
import { formatClock } from './transcriptLog.js';
import { IntegrityTimeline } from './IntegrityTimeline.js';
import type { IntegrityTimelineApi } from './timelineApi.js';
import { EvidenceGallery, type EvidenceGalleryProps } from '../evidence/EvidenceGallery.js';
import type { TranscriptEntry, TransparencyEvent } from '@examguard/contracts/exam';
import type { FindingNotesApi } from '../triage/findingsApi.js';
import { StudentFindings } from '../triage/StudentFindings.js';

const typeIcon: Record<TransparencyEvent['type'], string> = {
  HARDWARE: '🖥️',
  SOFTWARE: '🧩',
  VISION: '📷',
  GAZE: '👀',
  AUDIO: '🎙️',
};

/**
 * Consent-first follow-through: after the exam, students see exactly what the
 * monitoring recorded about their attempt. Nothing here is a verdict.
 */
export function TransparencyReport({
  attemptId,
  load,
  loadTranscript,
  timelineApi,
  evidence,
  findings,
}: {
  readonly attemptId: string;
  readonly load: (attemptId: string) => Promise<readonly TransparencyEvent[]>;
  readonly loadTranscript?: (attemptId: string) => Promise<readonly TranscriptEntry[]>;
  /** When provided, the same unified log the instructor sees is shown below. */
  readonly timelineApi?: IntegrityTimelineApi | undefined;
  /** When provided, the still snapshots saved for this attempt are listed too. */
  readonly evidence?: Pick<EvidenceGalleryProps, 'listEvidence' | 'loadImage'> | undefined;
  /** When provided, the triage findings are explained first, with a note box per finding. */
  readonly findings?: FindingNotesApi | undefined;
}) {
  const [events, setEvents] = useState<readonly TransparencyEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);

  useEffect(() => {
    let active = true;
    setEvents(null);
    setFailed(false);
    load(attemptId)
      .then((loaded) => {
        if (active) setEvents(loaded);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attemptId, load]);

  useEffect(() => {
    let active = true;
    setTranscript([]);
    loadTranscript?.(attemptId)
      .then((loaded) => {
        if (active) setTranscript(loaded);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [attemptId, loadTranscript]);

  return (
    <section className="transparency-report" aria-labelledby="transparency-title">
      <h2 id="transparency-title">What monitoring recorded</h2>
      <p className="transparency-note">
        This is the full list of integrity events stored for this attempt. An instructor reviews
        them in context — none of them is an automatic cheating verdict.
      </p>
      {findings !== undefined && <StudentFindings attemptId={attemptId} api={findings} />}
      {failed && <p role="alert">The transparency report could not be loaded. Try again later.</p>}
      {!failed && events === null && <p role="status">Loading report…</p>}
      {events !== null && events.length === 0 && (
        <p className="transparency-empty">✅ Nothing was flagged during this attempt.</p>
      )}
      {events !== null && events.length > 0 && (
        <ol className="transparency-list">
          {events.map((event, index) => (
            <li
              key={`${event.timestamp}-${index}`}
              className={`transparency-item transparency-item--${event.severity}`}
            >
              <span aria-hidden="true">{typeIcon[event.type]}</span>
              <span className="transparency-description">{event.description}</span>
              <time dateTime={event.timestamp}>
                {new Date(event.timestamp).toLocaleTimeString()}
              </time>
            </li>
          ))}
        </ol>
      )}
      {timelineApi !== undefined && (
        <IntegrityTimeline
          attemptId={attemptId}
          api={timelineApi}
          title="Full integrity log"
          loadEvidenceImage={evidence?.loadImage}
        />
      )}
      {evidence !== undefined && (
        <EvidenceGallery
          attemptId={attemptId}
          listEvidence={evidence.listEvidence}
          loadImage={evidence.loadImage}
          title="Photos saved"
          note="If something unusual was detected (another person, a phone, looking away for a long time), one still photo was saved for your instructor. These are all of them."
        />
      )}
      {transcript.length > 0 && (
        <section aria-labelledby="transcript-title" className="transparency-transcript">
          <h3 id="transcript-title">What was heard</h3>
          <p className="transparency-note">
            Text produced on this computer from short microphone clips. Audio itself is never
            stored.
          </p>
          <ol className="transcript-log">
            {transcript.map((entry, index) => (
              <li key={`${entry.capturedAt}-${index}`}>
                <time dateTime={entry.capturedAt}>{formatClock(new Date(entry.capturedAt))}</time>
                {' — '}
                {entry.text}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
