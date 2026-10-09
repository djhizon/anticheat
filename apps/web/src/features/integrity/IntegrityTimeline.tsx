import { useEffect, useMemo, useState } from 'react';
import { plural } from '@exam-anti-cheat/contracts';
import {
  INTEGRITY_TIMELINE_SOURCES,
  type IntegrityTimelineEntry,
  type IntegrityTimelineSource,
} from '@exam-anti-cheat/contracts/exam';

import type { IntegrityTimelineApi, TimelineFormat } from './timelineApi.js';

const sourceMeta: Record<
  IntegrityTimelineSource,
  { icon: string; label: string; one: string; many: string }
> = {
  camera: { icon: '📷', label: 'Camera', one: 'camera note', many: 'camera notes' },
  gaze: { icon: '👀', label: 'Gaze away', one: 'time', many: 'times' },
  audio: { icon: '🎙️', label: 'Voice activity', one: 'time', many: 'times' },
  transcript: { icon: '💬', label: 'Transcript', one: 'line', many: 'lines' },
  keyboard: { icon: '⌨️', label: 'Keyboard', one: 'note', many: 'notes' },
  pointer: { icon: '🖱️', label: 'Pointer', one: 'note', many: 'notes' },
  browser: { icon: '🌐', label: 'Browser', one: 'time', many: 'times' },
  desktop: { icon: '🖥️', label: 'Desktop', one: 'note', many: 'notes' },
  phone: { icon: '📱', label: 'iPhone', one: 'note', many: 'notes' },
  liveness: { icon: '🧑', label: 'Liveness', one: 'check', many: 'checks' },
  answer: { icon: '📝', label: 'Answers', one: 'save', many: 'saves' },
  system: { icon: '⚙️', label: 'System', one: 'note', many: 'notes' },
};

/**
 * Entries that point at a saved still photo get a "View photo" button. The image is fetched
 * only when asked for, shown as a small thumbnail, and its blob URL is revoked on unmount.
 */
function EvidenceLink({
  attemptId,
  evidenceId,
  load,
}: {
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly load: (attemptId: string, id: string) => Promise<string>;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed' | { readonly url: string }>(
    'idle',
  );
  const url = typeof state === 'object' ? state.url : null;
  useEffect(
    () => () => {
      if (url !== null && url.startsWith('blob:')) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url !== null) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="timeline-evidence">
        <img src={url} alt="Saved photo for this entry" />
      </a>
    );
  }
  return (
    <button
      type="button"
      className="timeline-evidence-link"
      disabled={state === 'loading'}
      onClick={() => {
        setState('loading');
        load(attemptId, evidenceId).then(
          (loaded) => setState({ url: loaded }),
          () => setState('failed'),
        );
      }}
    >
      {state === 'loading'
        ? 'Loading photo…'
        : state === 'failed'
          ? 'Photo unavailable'
          : 'View photo'}
    </button>
  );
}

/** One automatic re-read after this long, in case uploads were still arriving at first load. */
export const AUTO_REFRESH_MS = 5000;

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
  return `${meta.label}: ${plural(count, meta.one, meta.many)}${seconds > 0 ? `, ${seconds} s total` : ''}`;
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
  loadEvidenceImage,
}: {
  readonly attemptId: string;
  readonly api: IntegrityTimelineApi;
  readonly title?: string;
  /** When provided, entries that reference a saved photo offer a "View photo" button. */
  readonly loadEvidenceImage?: ((attemptId: string, id: string) => Promise<string>) | undefined;
}) {
  const [entries, setEntries] = useState<readonly IntegrityTimelineEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<IntegrityTimelineSource>>(new Set());
  const [downloadError, setDownloadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
    // Late uploads (voice bursts, transcripts) land after the first read: look once more.
    const later = setTimeout(() => void refresh(), AUTO_REFRESH_MS);
    return () => {
      active = false;
      clearTimeout(later);
    };
  }, [attemptId, api]);

  /** Re-reads the log in place, keeping what is on screen if the request fails. */
  function refresh(): Promise<void> {
    setRefreshing(true);
    return api
      .getTimeline(attemptId)
      .then((loaded) => {
        setEntries(loaded);
        setFailed(false);
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }

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
        person to review in context, not verdicts. Audio is never stored; the only images are the
        occasional still photos saved for unusual conditions.
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
              <button
                type="button"
                className="secondary-button"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
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
                      <span className="timeline-item__summary">
                        {entry.summary}
                        {loadEvidenceImage !== undefined &&
                          typeof entry.data?.evidenceId === 'string' && (
                            <>
                              {' '}
                              <EvidenceLink
                                key={entry.data.evidenceId}
                                attemptId={attemptId}
                                evidenceId={entry.data.evidenceId}
                                load={loadEvidenceImage}
                              />
                            </>
                          )}
                      </span>
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
