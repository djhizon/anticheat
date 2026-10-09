import { useEffect, useState } from 'react';
import type { TransparencyEvent } from '@exam-anti-cheat/contracts/exam';

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
}: {
  readonly attemptId: string;
  readonly load: (attemptId: string) => Promise<readonly TransparencyEvent[]>;
}) {
  const [events, setEvents] = useState<readonly TransparencyEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setEvents(null);
    setFailed(false);
    load(attemptId)
      .then((loaded) => { if (active) setEvents(loaded); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attemptId, load]);

  return (
    <section className="transparency-report" aria-labelledby="transparency-title">
      <h2 id="transparency-title">What monitoring recorded</h2>
      <p className="transparency-note">
        This is the full list of integrity events stored for this attempt. An instructor reviews them in context — none of
        them is an automatic cheating verdict.
      </p>
      {failed && <p role="alert">The transparency report could not be loaded. Try again later.</p>}
      {!failed && events === null && <p role="status">Loading report…</p>}
      {events !== null && events.length === 0 && <p className="transparency-empty">✅ Nothing was flagged during this attempt.</p>}
      {events !== null && events.length > 0 && (
        <ol className="transparency-list">
          {events.map((event, index) => (
            <li key={`${event.timestamp}-${index}`} className={`transparency-item transparency-item--${event.severity}`}>
              <span aria-hidden="true">{typeIcon[event.type]}</span>
              <span className="transparency-description">{event.description}</span>
              <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
