import { plural } from '@examguard/contracts';
import type {
  IntegrityTimelineEntry,
  IntegrityTimelineSeverity,
  IntegrityTimelineSource,
} from '@examguard/contracts/exam';

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

/** `lighting_poor_<class>` (e.g. `lighting_poor_backlit`) carries the class in its name. */
const LIGHTING_CLASS_TEXT: Record<string, string> = {
  too_dark: 'the face was too dark',
  backlit: 'the student was backlit (a bright window or lamp behind them)',
};

function lightingMapping(name: string): AppMapping | undefined {
  if (!name.startsWith('lighting_poor_')) return undefined;
  const cls = name.slice('lighting_poor_'.length);
  const reason = LIGHTING_CLASS_TEXT[cls];
  if (reason === undefined) return undefined;
  return {
    source: 'camera',
    kind: 'lighting_poor',
    severity: 'info',
    summary: `The camera lighting was poor for a while (${reason}); face tracking may be less reliable. Not a conduct issue`,
  };
}

const FLAG_MAP: Record<string, AppMapping> = {
  window_minimize_blocked: {
    source: 'desktop',
    kind: 'window_minimize_blocked',
    severity: 'notice',
    summary: 'An attempt to minimize or hide the exam window was blocked',
  },
  fullscreen_exit_blocked: {
    source: 'desktop',
    kind: 'fullscreen_exit_blocked',
    severity: 'notice',
    summary: 'An attempt to leave full screen was blocked and full screen was restored',
  },
  lockdown_emergency_exit: {
    source: 'desktop',
    kind: 'lockdown_emergency_exit',
    severity: 'flag',
    summary: 'The student ended the exam window lockdown with the emergency exit',
  },
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
  drop_blocked: {
    source: 'browser',
    kind: 'drop_blocked',
    severity: 'notice',
    summary: 'Dragging text into the exam was attempted and blocked',
  },
  copy_question: {
    source: 'browser',
    kind: 'copy_question',
    severity: 'notice',
    summary: 'Text on the exam page (outside the answer box) was copied',
  },
  pointer_outside_long: {
    source: 'pointer',
    kind: 'pointer_outside_long',
    severity: 'notice',
    summary:
      'Pointer stayed outside the exam window for more than 5 s while the exam window kept focus',
  },
  synthetic_input: {
    source: 'pointer',
    kind: 'synthetic_input',
    severity: 'notice',
    summary:
      'Pointer or keyboard input looked automated (scripted or remote-controlled), a lead only',
  },
  text_injected: {
    source: 'keyboard',
    kind: 'text_injected',
    severity: 'notice',
    summary: 'Long answer appeared at once (possible paste tool)',
  },
  uniform_typing: {
    source: 'keyboard',
    kind: 'uniform_typing',
    severity: 'notice',
    summary: 'Typing rhythm was unusually regular or fast for a sustained stretch',
  },
  burst_after_idle: {
    source: 'keyboard',
    kind: 'burst_after_idle',
    severity: 'notice',
    summary: 'A long answer was typed quickly after a long pause with no activity',
  },
  typing_drift: {
    source: 'keyboard',
    kind: 'typing_drift',
    severity: 'notice',
    summary: 'Typing rhythm differs strongly from earlier in the exam (a lead only)',
  },
  phone_detected: {
    source: 'camera',
    kind: 'phone_in_view',
    severity: 'notice',
    summary: 'The browser camera check reported a possible phone in view',
  },
  earbuds_detected: {
    source: 'camera',
    kind: 'earbuds_in_view',
    severity: 'notice',
    summary:
      'The on-device camera check reported possible earbuds (a lead only; small objects are often missed or misread)',
  },
  headphones_detected: {
    source: 'camera',
    kind: 'headphones_in_view',
    severity: 'notice',
    summary: 'The on-device camera check reported possible headphones (a lead only)',
  },
  glasses_detected: {
    source: 'camera',
    kind: 'glasses_worn',
    severity: 'info',
    summary:
      'Glasses worn. This is normal and not a conduct issue; the check cannot tell smart glasses from ordinary ones',
  },
  watch_detected: {
    source: 'camera',
    kind: 'watch_visible',
    severity: 'info',
    summary:
      'A wristwatch was visible. The check cannot tell a smartwatch from an ordinary watch, so this is information only',
  },
  phone_detected_detailed: {
    source: 'camera',
    kind: 'phone_in_view',
    severity: 'notice',
    summary: 'The detailed on-device camera check reported a possible phone in view',
  },
  notes_detected: {
    source: 'camera',
    kind: 'notes_in_view',
    severity: 'notice',
    summary: 'The on-device camera check reported what may be paper notes in view (a lead only)',
  },
  extra_person_detected: {
    source: 'camera',
    kind: 'extra_person_in_view',
    severity: 'notice',
    summary: 'The on-device camera check reported what may be a second person in view',
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
  iphone_paired: {
    source: 'phone',
    kind: 'iphone_paired',
    severity: 'info',
    summary: 'The iPhone was paired for presence checks',
  },
  iphone_lost: {
    source: 'phone',
    kind: 'iphone_lost',
    severity: 'notice',
    summary:
      'The paired iPhone stopped answering (app closed, phone locked or a network drop; not proof of cheating)',
  },
  iphone_reconnected: {
    source: 'phone',
    kind: 'iphone_reconnected',
    severity: 'info',
    summary: 'The paired iPhone answered again',
  },
  phone_left_app: {
    source: 'phone',
    kind: 'phone_left_app',
    severity: 'notice',
    summary:
      'The iPhone app went to the background for a while (phone picked up or another app opened), a lead only',
  },
  iphone_disconnected: {
    source: 'phone',
    kind: 'iphone_disconnected',
    severity: 'notice',
    summary: 'The paired iPhone stopped checking in (answering was not blocked)',
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
  brightness_restored: {
    source: 'desktop',
    kind: 'brightness_restored',
    severity: 'info',
    summary: 'Screen brightness was lowered during the exam and the app set it back to maximum',
  },
  lighting_poor: {
    source: 'camera',
    kind: 'lighting_poor',
    severity: 'info',
    summary: 'The camera lighting was poor for a while, which can make face tracking less reliable',
  },
  liveness_unverified: {
    source: 'liveness',
    kind: 'liveness_unverified',
    severity: 'notice',
    summary:
      'The presence check could not be completed after several tries and the student continued; an instructor may want to review (this is not a conduct finding)',
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
  screen_recording_stopped: {
    source: 'system',
    kind: 'screen_recording_stopped',
    severity: 'notice',
    summary:
      'Screen recording was not running during the exam (sharing ended or the page reloaded); answering paused until it was resumed',
  },
  screen_recording_resumed: {
    source: 'system',
    kind: 'screen_recording_resumed',
    severity: 'info',
    summary: 'Screen recording resumed and answering continued',
  },
  presence_check_passed: {
    source: 'liveness',
    kind: 'presence_check_passed',
    severity: 'info',
    summary: 'A quick presence spot check passed',
  },
  presence_check_failed: {
    source: 'liveness',
    kind: 'presence_check_failed',
    severity: 'notice',
    summary:
      'A quick presence spot check could not confirm the student after a retry (lighting, camera angle or looking away can cause this; not a conduct finding)',
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
    const mapped = FLAG_MAP[name] ?? lightingMapping(name);
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
function keystrokeEntries(rows: TimelineRows['keystrokes'], attemptStart: string | null): Entry[] {
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
  // Buckets are keyed by the minute, so the first one can begin before the attempt did.
  const floor = attemptStart === null ? Number.NEGATIVE_INFINITY : Date.parse(attemptStart);
  return [...buckets.values()].map((bucket) =>
    entry(
      Date.parse(bucket.at) < floor ? (attemptStart as string) : bucket.at,
      'keyboard',
      'typing_rhythm',
      'info',
      `Typed ${plural(bucket.dwell.length, 'keystroke')} (median hold ${median(bucket.dwell)} ms, median gap ${median(bucket.flight)} ms)`,
      {
        keystrokes: bucket.dwell.length,
        medianDwellMs: median(bucket.dwell),
        medianFlightMs: median(bucket.flight),
      },
    ),
  );
}

/**
 * Input-behaviour windows are aggregates; only the notable ones become entries. Pointer
 * excursions of 2 s or more are listed as plain facts, and an injected answer with a
 * still pointer is called out because the combination is the stronger lead.
 */
const OUTSIDE_LISTED_MS = 2_000;

function inputEntries(rows: TimelineRows['input']): Entry[] {
  const out: Entry[] = [];
  for (const row of rows) {
    const at = iso(row.window_start);
    if (at === null) continue;
    if (row.pointer_outside_ms >= OUTSIDE_LISTED_MS) {
      const times = row.pointer_leaves > 1 ? ` (${plural(row.pointer_leaves, 'time')})` : '';
      out.push(
        entry(
          at,
          'pointer',
          'pointer_outside',
          row.longest_outside_ms >= 10_000 ? 'notice' : 'info',
          `Pointer outside the exam window for ${seconds(row.pointer_outside_ms)}${times}`,
          {
            leaves: row.pointer_leaves,
            outsideMs: row.pointer_outside_ms,
            longestMs: row.longest_outside_ms,
            ...(row.outside_edge === null ? {} : { edge: row.outside_edge }),
          },
        ),
      );
    }
    if (row.idle_pointer_injections > 0) {
      out.push(
        entry(
          at,
          'keyboard',
          'injection_idle_pointer',
          'flag',
          'Long answer appeared at once while the mouse was still (possible paste tool)',
          { injections: row.injections, idlePointerInjections: row.idle_pointer_injections },
        ),
      );
    }
  }
  return out;
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
          ? `Answer grew by ${plural(added, 'word')} in one save (now ${plural(row.word_count, 'word')})`
          : `Answer saved (${plural(row.word_count, 'word')})`,
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
  text_injected: 'a long answer appeared at once',
  earbuds_detected: 'possible earbuds',
  headphones_detected: 'possible headphones',
};

const EVIDENCE_SOURCE: Record<string, IntegrityTimelineSource> = {
  webcam: 'camera',
  screen: 'desktop',
  desk_camera: 'phone', // legacy rows from the retired iPhone desk camera
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
  out.push(...keystrokeEntries(rows.keystrokes, iso(meta.startedAt)));
  out.push(...inputEntries(rows.input));
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
