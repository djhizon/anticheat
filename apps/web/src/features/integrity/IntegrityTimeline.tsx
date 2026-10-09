import { useEffect, useMemo, useState } from 'react';
import {
  INTEGRITY_TIMELINE_SOURCES,
  type IntegrityTimelineEntry,
  type IntegrityTimelineSource,
} from '@exam-anti-cheat/contracts/exam';

import type { IntegrityTimelineApi, TimelineFormat } from './timelineApi.js';

const sourceMeta: Record<IntegrityTimelineSource, { icon: string; label: string; noun: string }> = {
  camera: { icon: '📷', label: 'Camera', noun: 'camera notes' },
  gaze: { icon: '👀', label: 'Gaze away', noun: 'times' },
  audio: { icon: '🎙️', label: 'Voice activity', noun: 'times' },
  transcript: { icon: '💬', label: 'Transcript', noun: 'lines' },
  keyboard: { icon: '⌨️', label: 'Keyboard', noun: 'notes' },
  browser: { icon: '🌐', label: 'Browser', noun: 'times' },
  desktop: { icon: '🖥️', label: 'Desktop', noun: 'notes' },
  phone: { icon: '📱', label: 'iPhone', noun: 'notes' },
  liveness: { icon: '🧑', label: 'Liveness', noun: 'checks' },
  answer: { icon: '📝', label: 'Answers', noun: 'saves' },
  system: { icon: '⚙️', label: 'System', noun: 'notes' },
};

const severityLabel = { info: 'Info', notice: 'Worth a look', flag: 'Review' } as const;

function durationSeconds(entries: readonly IntegrityTimelineEntry[]): number {
  let ms = 0;
  for (const entry of entries) {
    const value = entry.data?.durationMs;
    if (typeof value === 'number' && Number.isFinite(value)) ms += value;
  }
  return Math.round(ms / 1000);
}

/** e.g. "Gaze away: 7 times, 42 s total". */
export function summarizeSource(
  source: IntegrityTimelineSource,
  entries: readonly IntegrityTimelineEntry[],
): string {
  const meta = sourceMeta[source];
  const seconds = durationSeconds(entries);
  const count = entries.length;
  const noun = count === 1 && meta.noun === 'times' ? 'time' : meta.noun;
  return `${meta.label}: ${count} ${noun}${seconds > 0 ? `, ${seconds} s total` : ''}`;
}

function minuteKey(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toISOString().slice(0, 16);
}

function formatMinute(key: string): string {
  const date = new Date(`${key}:00.000Z`);
  return Number.isNaN(date.getTime())
    ? key
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSecond(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * One chronological log of everything monitoring recorded for an attempt,
 * grouped by minute, filterable by source, downloadable as CSV or JSON.
 * Entries are leads for a human reviewer, never verdicts.
 */
export function IntegrityTimeline({
  attemptId,
  api,
  title = 'Integrity log',
}: {
  readonly attemptId: string;
  readonly api: IntegrityTimelineApi;
  readonly title?: string;
}) {
  const [entries, setEntries] = useState<readonly IntegrityTimelineEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<IntegrityTimelineSource>>(new Set());
  const [downloadError, setDownloadError] = useState(false);

  useEffect(() => {
    let active = true;
    setEntries(null);
    setFailed(false);
    setHidden(new Set());
    api
      .getTimeline(attemptId)
      .then((loaded) => {
        if (active) setEntries(loaded);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attemptId, api]);

  const bySource = useMemo(() => {
    const map = new Map<IntegrityTimelineSource, IntegrityTimelineEntry[]>();
    for (const entry of entries ?? []) {
      const list = map.get(entry.source) ?? [];
      list.push(entry);
      map.set(entry.source, list);
    }
    return map;
  }, [entries]);

  const groups = useMemo(() => {
    const out: Array<{ key: string; items: IntegrityTimelineEntry[] }> = [];
    for (const entry of entries ?? []) {
      if (hidden.has(entry.source)) continue;
      const key = minuteKey(entry.at);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(entry);
      else out.push({ key, items: [entry] });
    }
    return out;
  }, [entries, hidden]);

  function toggle(source: IntegrityTimelineSource): void {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function download(format: TimelineFormat): void {
    setDownloadError(false);
    api.downloadTimeline(attemptId, format).catch(() => setDownloadError(true));
  }

  const present = INTEGRITY_TIMELINE_SOURCES.filter((source) => bySource.has(source));

  return (
    <section className="integrity-timeline" aria-label={title}>
      <h3 className="integrity-timeline__title">{title}</h3>
      <p className="transparency-note">
        Everything monitoring recorded for this attempt, in time order. Entries are leads for a
        person to review in context, not verdicts. No images or audio are stored.
      </p>
      {failed && <p role="alert">The integrity log could not be loaded. Try again later.</p>}
      {!failed && entries === null && <p role="status">Loading log…</p>}
      {entries !== null && (
        <>
          <ul className="integrity-timeline__counts" aria-label="Counts by source">
            {present.map((source) => (
              <li key={source}>{summarizeSource(source, bySource.get(source) ?? [])}</li>
            ))}
          </ul>
          <div className="integrity-timeline__toolbar">
            <div className="integrity-timeline__filters" role="group" aria-label="Filter by source">
              {present.map((source) => (
                <button
                  key={source}
                  type="button"
                  className={`timeline-chip timeline-chip--${source}`}
                  aria-pressed={!hidden.has(source)}
                  onClick={() => toggle(source)}
                >
                  <span aria-hidden="true">{sourceMeta[source].icon}</span>{' '}
                  {sourceMeta[source].label}
                </button>
              ))}
            </div>
            <div className="integrity-timeline__downloads">
              <button type="button" className="secondary-button" onClick={() => download('csv')}>
                Download CSV
              </button>
              <button type="button" className="secondary-button" onClick={() => download('json')}>
                Download JSON
              </button>
            </div>
          </div>
          {downloadError && <p role="alert">The log could not be downloaded.</p>}
          {groups.length === 0 && <p className="transparency-empty">Nothing to show.</p>}
          <ol className="integrity-timeline__list">
            {groups.map((group) => (
              <li key={group.key} className="integrity-timeline__minute">
                <h4>
                  <time dateTime={`${group.key}:00.000Z`}>{formatMinute(group.key)}</time>
                </h4>
                <ul>
                  {group.items.map((entry, index) => (
                    <li
                      key={`${entry.at}-${entry.kind}-${index}`}
                      className={`timeline-item timeline-item--${entry.severity}`}
                    >
                      <span
                        className={`timeline-chip timeline-chip--${entry.source}`}
                        title={sourceMeta[entry.source].label}
                      >
                        <span aria-hidden="true">{sourceMeta[entry.source].icon}</span>{' '}
                        {sourceMeta[entry.source].label}
                      </span>
                      <span className="timeline-item__summary">{entry.summary}</span>
                      <span className="timeline-item__severity">
                        {severityLabel[entry.severity]}
                      </span>
                      <time dateTime={entry.at}>{formatSecond(entry.at)}</time>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
