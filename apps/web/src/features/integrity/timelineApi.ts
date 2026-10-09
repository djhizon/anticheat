import {
  INTEGRITY_TIMELINE_SOURCES,
  type IntegrityTimelineEntry,
} from '@exam-anti-cheat/contracts/exam';

import type { FetchLike } from '../auth/api.js';

export type TimelineFormat = 'csv' | 'json';

/** What `IntegrityTimeline` needs; the student and instructor APIs both provide it. */
export interface IntegrityTimelineApi {
  getTimeline(attemptId: string): Promise<readonly IntegrityTimelineEntry[]>;
  downloadTimeline(attemptId: string, format: TimelineFormat): Promise<void>;
}

const sources = new Set<string>(INTEGRITY_TIMELINE_SOURCES);
const severities = new Set(['info', 'notice', 'flag']);

export function parseTimelineEntries(body: unknown): IntegrityTimelineEntry[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { entries?: unknown }).entries)
  ) {
    throw new Error('Unexpected response.');
  }
  return (body as { entries: unknown[] }).entries.filter(
    (item): item is IntegrityTimelineEntry =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as IntegrityTimelineEntry).at === 'string' &&
      typeof (item as IntegrityTimelineEntry).kind === 'string' &&
      typeof (item as IntegrityTimelineEntry).summary === 'string' &&
      sources.has((item as IntegrityTimelineEntry).source) &&
      severities.has((item as IntegrityTimelineEntry).severity),
  );
}

export function timelineUrl(baseUrl: string, attemptId: string, format?: TimelineFormat): string {
  const path = `${baseUrl}/exam/attempts/${encodeURIComponent(attemptId)}/timeline`;
  return format === undefined ? path : `${path}?format=${format}`;
}

/** Fetch the download variant and hand it to the browser as a file. */
export async function downloadTimelineFile(
  fetchImpl: FetchLike,
  url: string,
  filename: string,
): Promise<void> {
  const response = await fetchImpl(url, { method: 'GET', credentials: 'include' });
  if (!response.ok) throw new Error('The log could not be downloaded.');
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(href);
  }
}
