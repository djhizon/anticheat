import type {
  IntegrityTimelineEntry,
  IntegrityTimelineSeverity,
  IntegrityTimelineSource,
} from '@exam-anti-cheat/contracts/exam';

import type { TimelineRows } from './integrityRepository.js';

/**
 * Merge every stored signal for one attempt into a single chronological list.
 * Wording is deliberately plain and non-accusatory: each entry is a lead for a
 * human reviewer, never a verdict. No images, audio, or answer text is carried.
 */

type Entry = IntegrityTimelineEntry;

const seconds = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? `${Math.round(s * 10) / 10} s` : `${Math.round(s)} s`;
};

function entry(
  at: string,
  source: IntegrityTimelineSource,
  kind: string,
  severity: IntegrityTimelineSeverity,
  summary: string,
  data?: Record<string, unknown>,
): Entry {
  return data === undefined
    ? { at, source, kind, severity, summary }
    : { at, source, kind, severity, summary, data };
}

/** Stored timestamps are ISO strings; anything unparseable is dropped rather than guessed. */
function iso(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const GAZE_DIRECTION_TEXT: Record<string, string> = {
  left: 'Head turned to the left',
  right: 'Head turned to the right',
  up: 'Head tilted up',
  down: 'Head tilted down',
  away: 'Looked away from the screen',
};

function gazeEntry(row: TimelineRows['gaze'][number]): Entry | null {
  const at = iso(row.off_screen_start);
  if (at === null) return null;
  const data: Record<string, unknown> = { direction: row.direction, durationMs: row.duration_ms };
  if (row.yaw !== null) data.yaw = row.yaw;
  if (row.pitch !== null) data.pitch = row.pitch;
  const length = seconds(row.duration_ms);
  if (row.direction === 'no_face') {
    return entry(
      at,
      'camera',
      'face_missing',
      row.duration_ms >= 10_000 ? 'notice' : 'info',
      `No face was in view of the camera for ${length}`,
      data,
    );
  }
  if (row.direction === 'multiple_faces') {
    return entry(
      at,
      'camera',
      'multiple_faces',
      row.duration_ms >= 5_000 ? 'flag' : 'notice',
      `More than one face was in view of the camera for ${length}`,
      data,
    );
  }
  const text = GAZE_DIRECTION_TEXT[row.direction] ?? GAZE_DIRECTION_TEXT.away!;
  const severity: IntegrityTimelineSeverity =
    row.duration_ms >= 15_000 ? 'flag' : row.duration_ms >= 5_000 ? 'notice' : 'info';
  return entry(at, 'gaze', `gaze_${row.direction}`, severity, `${text} for ${length}`, data);
}

interface AppMapping {
  readonly source: IntegrityTimelineSource;
  readonly kind: string;
  readonly severity: IntegrityTimelineSeverity;
  readonly summary: string;
}

const FLAG_MAP: Record<string, AppMapping> = {
  focus_lost: {
    source: 'browser',
    kind: 'focus_lost',
    severity: 'notice',
    summary: 'The exam window lost focus',
  },
  page_hidden: {
    source: 'browser',
    kind: 'page_hidden',
    severity: 'notice',
    summary: 'The exam tab was hidden or switched away from',
  },
  paste_blocked: {
    source: 'browser',
    kind: 'paste_blocked',
    severity: 'notice',
    summary: 'A paste into the exam was attempted and blocked',
  },
  keystroke_violation: {
    source: 'keyboard',
    kind: 'keystroke_uniform',
    severity: 'notice',
    summary: 'Typing rhythm was unusually uniform for a short stretch',
  },
  suspicious_timing: {
    source: 'keyboard',
    kind: 'answer_fast',
    severity: 'notice',
    summary: 'A long answer appeared faster than typical typing speed',
  },
  phone_detected: {
    source: 'camera',
    kind: 'phone_in_view',
    severity: 'notice',
    summary: 'The browser camera check reported a possible phone in view',
  },
  camera_disconnected: {
    source: 'camera',
    kind: 'camera_disconnected',
    severity: 'flag',
    summary: 'The camera was disconnected during the exam',
  },
  camera_swapped_to_virtual: {
    source: 'camera',
    kind: 'camera_virtual',
    severity: 'flag',
    summary: 'The active camera looks like a virtual camera',
  },
  virtual_camera_connected: {
    source: 'camera',
    kind: 'camera_virtual',
    severity: 'flag',
    summary: 'A virtual camera device appeared',
  },
  capture_device_connected: {
    source: 'camera',
    kind: 'capture_device',
    severity: 'flag',
    summary: 'A video-capture device appeared',
  },
  desk_camera_extra_person: {
    source: 'phone',
    kind: 'desk_extra_person',
    severity: 'notice',
    summary: 'The paired iPhone desk camera reported more than one person',
  },
  desk_camera_left_frame: {
    source: 'phone',
    kind: 'desk_left_frame',
    severity: 'notice',
    summary: 'The paired iPhone desk camera reported nobody in frame',
  },
  iphone_paired: {
    source: 'phone',
    kind: 'iphone_paired',
    severity: 'info',
    summary: 'An iPhone was paired as a desk camera',
  },
  desktop_demo_mode: {
    source: 'desktop',
    kind: 'demo_mode',
    severity: 'notice',
    summary: 'The desktop app ran in Demo mode, which relaxes environment checks',
  },
  capture_display_connected: {
    source: 'desktop',
    kind: 'capture_display',
    severity: 'flag',
    summary: 'A display that looks like capture or mirroring hardware was connected',
  },
  recording_started: {
    source: 'system',
    kind: 'recording_started',
    severity: 'info',
    summary: 'Screen recording started',
  },
  recording_stopped: {
    source: 'system',
    kind: 'recording_stopped',
    severity: 'info',
    summary: 'Screen recording stopped',
  },
};

function appEntry(row: TimelineRows['apps'][number]): Entry | null {
  const at = iso(row.created_at);
  if (at === null) return null;
  const app = row.foreground_app;
  if (row.display_count > 1) {
    return entry(
      at,
      'desktop',
      'multiple_displays',
      'flag',
      `More than one display was connected (${row.display_count})`,
      { displayCount: row.display_count },
    );
  }
  if (app.startsWith('flag:vision_')) {
    const label = app.slice('flag:vision_'.length).replaceAll('_', ' ');
    return entry(
      at,
      'camera',
      'vision_object',
      'notice',
      `Server image check possibly saw: ${label} (a lead only, such checks are often wrong)`,
      { label },
    );
  }
  if (app.startsWith('flag:')) {
    const name = app.slice(5);
    const mapped = FLAG_MAP[name];
    if (mapped !== undefined) {
      return entry(at, mapped.source, mapped.kind, mapped.severity, mapped.summary);
    }
    return entry(at, 'system', 'flag', 'notice', `Recorded: ${name.replaceAll('_', ' ')}`, {
      name,
    });
  }
  if (app === '' || app === 'unknown') return null;
  return entry(at, 'desktop', 'foreground_app', 'notice', `Another app was in front: ${app}`, {
    app,
  });
}

function livenessEntry(row: TimelineRows['liveness'][number]): Entry | null {
  const at = iso(row.created_at);
  if (at === null) return null;
  const names = ['noise', 'flash', 'challenge', 'jitter'];
  const layer = names[row.layer - 1] ?? `layer ${row.layer}`;
  let detail = '';
  const data: Record<string, unknown> = { layer: row.layer, result: row.result };
  try {
    const parsed: unknown = JSON.parse(row.details_json);
    if (typeof parsed === 'object' && parsed !== null) {
      const details = parsed as Record<string, unknown>;
      if (typeof details.detail === 'string') detail = details.detail.slice(0, 200);
      if (details.earbuds === true) data.earbuds = true;
      if (details.phone === 'observed' || details.phone === 'candidate') data.phone = details.phone;
    }
  } catch {
    // Details are optional context only.
  }
  if (detail !== '') data.detail = detail;
  if (row.result === 'pass') {
    return entry(at, 'liveness', 'liveness_pass', 'info', `Liveness check passed (${layer})`, data);
  }
  if (row.result === 'skip') {
    return entry(
      at,
      'liveness',
      'liveness_skip',
      'notice',
      `Liveness check was skipped (${layer})`,
      data,
    );
  }
  const extra = data.phone !== undefined ? ' A phone may have been in view.' : '';
  return entry(
    at,
    'liveness',
    'liveness_fail',
    'flag',
    `Liveness check did not pass (${layer}). A person should take a look.${extra}`,
    data,
  );
}

/** Per-minute typing-rhythm summaries so the log is not one row per keystroke. */
function keystrokeEntries(rows: TimelineRows['keystrokes']): Entry[] {
  const buckets = new Map<string, { at: string; dwell: number[]; flight: number[] }>();
  for (const row of rows) {
    const at = iso(row.created_at);
    if (at === null) continue;
    const minute = at.slice(0, 16);
    const bucket = buckets.get(minute) ?? { at: `${minute}:00.000Z`, dwell: [], flight: [] };
    bucket.dwell.push(row.dwell_ms);
    bucket.flight.push(row.flight_ms);
    buckets.set(minute, bucket);
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Math.round(
      sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    );
  };
  return [...buckets.values()].map((bucket) =>
    entry(
      bucket.at,
      'keyboard',
      'typing_rhythm',
      'info',
      `Typed ${bucket.dwell.length} keystrokes (median hold ${median(bucket.dwell)} ms, median gap ${median(bucket.flight)} ms)`,
      {
        keystrokes: bucket.dwell.length,
        medianDwellMs: median(bucket.dwell),
        medianFlightMs: median(bucket.flight),
      },
    ),
  );
}

const LARGE_ADDITION_WORDS = 40;

function revisionEntries(rows: TimelineRows['revisions']): Entry[] {
  const previous = new Map<string, number>();
  const out: Entry[] = [];
  for (const row of rows) {
    const at = iso(row.created_at);
    if (at === null) continue;
    const before = previous.get(row.question_version_id) ?? 0;
    previous.set(row.question_version_id, row.word_count);
    const added = row.word_count - before;
    const large = added >= LARGE_ADDITION_WORDS;
    out.push(
      entry(
        at,
        'answer',
        large ? 'answer_large_addition' : 'answer_saved',
        large ? 'notice' : 'info',
        large
          ? `Answer grew by ${added} words in one save (now ${row.word_count} words)`
          : `Answer saved (${row.word_count} words)`,
        { questionId: row.question_version_id, wordCount: row.word_count, wordsAdded: added },
      ),
    );
  }
  return out;
}

/** Plain, non-accusatory description of why a photo was saved. */
const EVIDENCE_TEXT: Record<string, string> = {
  multiple_faces: 'another person in view',
  no_face: 'no face in view',
  phone_detected: 'a possible phone in view',
  look_away: 'looked away for a while',
  overlay_detected: 'a possible overlay on screen',
  disallowed_app_foreground: 'another app in front',
  extra_person: 'another person in view of the desk camera',
  left_frame: 'nobody in view of the desk camera',
  hands_not_visible: 'hands not visible to the desk camera',
};

const EVIDENCE_SOURCE: Record<string, IntegrityTimelineSource> = {
  webcam: 'camera',
  screen: 'desktop',
  desk_camera: 'phone',
};

function evidenceEntry(row: TimelineRows['evidence'][number]): Entry | null {
  const at = iso(row.captured_at);
  if (at === null) return null;
  const source = EVIDENCE_SOURCE[row.source] ?? 'system';
  const reason = EVIDENCE_TEXT[row.trigger] ?? row.trigger.replaceAll('_', ' ');
  const what = row.source === 'screen' ? 'Screenshot' : 'Photo';
  return entry(at, source, 'evidence_snapshot', 'notice', `${what} saved: ${reason}`, {
    evidenceId: row.id,
    trigger: row.trigger,
    source: row.source,
  });
}

const AUDIT_TEXT: Record<string, string> = {
  'auth.logged_in': 'The student signed in',
  'auth.logged_out': 'The student signed out',
  'auth.registered': 'The account was registered',
};

export function buildTimeline(rows: TimelineRows): IntegrityTimelineEntry[] {
  const out: Entry[] = [];
  const push = (value: Entry | null) => {
    if (value !== null) out.push(value);
  };

  const { meta } = rows;
  push(
    entry(
      iso(meta.startedAt) ?? meta.startedAt,
      'system',
      'attempt_started',
      'info',
      'The attempt started',
    ),
  );
  if (meta.submittedAt !== null && iso(meta.submittedAt) !== null) {
    push(
      entry(
        iso(meta.submittedAt)!,
        'system',
        'attempt_submitted',
        'info',
        'The attempt was submitted',
      ),
    );
  }
  if (meta.expiredAt !== null && iso(meta.expiredAt) !== null) {
    push(
      entry(
        iso(meta.expiredAt)!,
        'system',
        'attempt_expired',
        'info',
        'Time ran out and the attempt closed',
      ),
    );
  }

  for (const row of rows.gaze) push(gazeEntry(row));
  for (const row of rows.apps) push(appEntry(row));
  for (const row of rows.liveness) push(livenessEntry(row));
  out.push(...keystrokeEntries(rows.keystrokes));
  out.push(...revisionEntries(rows.revisions));

  for (const row of rows.voice) {
    const at = iso(row.detected_at);
    if (at === null) continue;
    push(
      entry(
        at,
        'audio',
        'voice_activity',
        row.duration_ms >= 5_000 ? 'notice' : 'info',
        `Sound that looks like speech for ${seconds(row.duration_ms)} (not proof of speech)`,
        { durationMs: row.duration_ms, peakDb: Math.round(row.peak_db * 10) / 10 },
      ),
    );
  }
  for (const row of rows.transcripts) {
    const at = iso(row.captured_at);
    if (at === null) continue;
    const text = row.text.length > 300 ? `${row.text.slice(0, 300)}...` : row.text;
    push(entry(at, 'transcript', 'transcript', 'info', `Heard: "${text}"`));
  }
  for (const row of rows.phones) {
    const at = iso(row.created_at);
    if (at !== null)
      push(entry(at, 'phone', 'phone_pairing_started', 'info', 'A phone pairing was started'));
  }
  for (const row of rows.evidence) push(evidenceEntry(row));
  for (const row of rows.audits) {
    const at = iso(row.occurred_at);
    if (at !== null)
      push(entry(at, 'system', row.action, 'info', AUDIT_TEXT[row.action] ?? 'Account activity'));
  }

  // Array.prototype.sort is stable, so same-instant entries keep their insertion order.
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const CSV_COLUMNS = ['at', 'source', 'kind', 'severity', 'summary', 'data'] as const;

/** RFC 4180 quoting plus a guard so spreadsheets never evaluate a cell as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function timelineToCsv(entries: readonly IntegrityTimelineEntry[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const e of entries) {
    lines.push(
      [
        e.at,
        e.source,
        e.kind,
        e.severity,
        e.summary,
        e.data === undefined ? '' : JSON.stringify(e.data),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
