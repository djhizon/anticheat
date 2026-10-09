import { plural } from '@examguard/contracts';
import type {
  AttemptFindings,
  Finding,
  FindingConfidence,
  FindingType,
  FindingWindow,
  ReviewLevel,
} from '@examguard/contracts/findings';

import type { TimelineRows } from './integrityRepository.js';

/**
 * Findings engine: turns one attempt's stored timeline into at most six plain-language
 * findings so an instructor only opens attempts that need a look. Every finding needs at
 * least two corroborating signals; one weak signal on its own never becomes a finding.
 * Findings are leads for a human reviewer, never verdicts, and the wording says so.
 */

export const FINDING_THRESHOLDS = {
  /** The student's own first minutes of the attempt are the baseline for "their normal". */
  baselineMs: 180_000,
  /** Evidence snapshots this close to a window are attached to the finding. */
  evidencePadMs: 10_000,
  /** Contributing moments closer than this are merged into one window. */
  windowMergeMs: 60_000,
  maxWindows: 8,
  /** Most important first when confidence ties. */
  priority: [
    'second_person',
    'external_answer_entry',
    'phone_use',
    'notes_or_second_screen',
    'left_exam',
    'environment_risk',
  ] as readonly FindingType[],
  notes: {
    /** Glances to the same region (yaw and pitch both within ± this many degrees). */
    regionDegrees: 8,
    minGlances: 8,
    /** Of those, at least this many must be followed by typing within `followMs`. */
    minFollowedByTyping: 4,
    highFollowedByTyping: 8,
    followMs: 10_000,
    /**
     * A region the student already glanced at (and typed after) this many times during the
     * baseline at a similar rate is a habit (keyboard, notes allowed, second monitor), not a lead.
     */
    habitBaselineGlances: 3,
    habitRateRatio: 0.75,
  },
  typingBurst: {
    /** Keystrokes or characters inside `followMs` that count as a burst (floor). */
    minKeystrokes: 12,
    minChars: 40,
    /** The floor is raised to this multiple of the student's own baseline rate. */
    baselineMultiplier: 2,
    /** An answer save that grows by this many words also counts as a burst. */
    revisionWords: 20,
  },
  secondPerson: {
    minFaceEpisodeMs: 2_000,
    minFaceEpisodes: 2,
    longFaceEpisodeMs: 10_000,
    minVoiceMs: 2_000,
    minTranscriptWords: 3,
    voiceTranscriptGapMs: 15_000,
    mediumSpeechPairs: 2,
  },
  answerEntry: {
    /** Injection moments closer than this are the same episode. */
    episodeMergeMs: 30_000,
    /** A window with at most this many pointer events counts as a still pointer. */
    stillPointerEvents: 0,
    /** Windows overlapping this span before a burst must all show a still pointer. */
    idleLookbackMs: 30_000,
  },
  phone: {
    minDownGazeMs: 5_000,
    /** A downward gaze and an iPhone lost / left-app event this close are "around the same time". */
    correlationMs: 60_000,
    detectionMergeMs: 30_000,
    minDetections: 2,
  },
  leftExam: {
    /** A focus loss and a hidden page usually fire together; merge them into one episode. */
    episodeMergeMs: 5_000,
    minEpisodes: 2,
    mediumEpisodes: 3,
    highEpisodes: 5,
    /** Presence spot checks only count once they failed this many times. */
    presenceFailures: 2,
  },
  environment: {
    strong: [
      'camera_swapped_to_virtual',
      'virtual_camera_connected',
      'capture_device_connected',
      'capture_display_connected',
      'camera_feed_paused_virtual_camera',
      'camera_feed_paused_virtual_camera_attested',
    ] as readonly string[],
    weak: ['camera_unverified', 'multiple_displays'] as readonly string[],
    highStrongEvents: 3,
  },
} as const;

const T = FINDING_THRESHOLDS;

interface Moment {
  readonly at: number;
  readonly end: number;
}

interface FlagEvent {
  readonly at: number;
  readonly name: string;
}

interface Candidate {
  readonly type: FindingType;
  readonly confidence: FindingConfidence;
  readonly title: string;
  readonly reasons: readonly string[];
  readonly moments: readonly Moment[];
}

const CONFIDENCE_RANK: Record<FindingConfidence, number> = { high: 3, medium: 2, low: 1 };

function parseMs(value: string): number | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const seconds = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? `${Math.round(s * 10) / 10} s` : `${Math.round(s)} s`;
};

const overlaps = (a: Moment, b: Moment): boolean => a.at <= b.end && b.at <= a.end;

/** Sort moments and merge any that are closer than `gapMs` into one. */
function mergeMoments(moments: readonly Moment[], gapMs: number): Moment[] {
  const sorted = [...moments].sort((a, b) => a.at - b.at);
  const out: Moment[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && m.at <= last.end + gapMs) {
      out[out.length - 1] = { at: last.at, end: Math.max(last.end, m.end) };
    } else {
      out.push(m);
    }
  }
  return out;
}

/** App-event rows as named flags (`flag:x` → `x`, a foreground app → `foreground_app`). */
function flagEvents(rows: TimelineRows): FlagEvent[] {
  const out: FlagEvent[] = [];
  for (const row of rows.apps) {
    const at = parseMs(row.created_at);
    if (at === null) continue;
    if (row.display_count > 1) out.push({ at, name: 'multiple_displays' });
    const app = row.foreground_app;
    if (app.startsWith('flag:')) out.push({ at, name: app.slice(5) });
    else if (app !== '' && app !== 'unknown') out.push({ at, name: 'foreground_app' });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── Typing profile (used by several findings) ────────────────────────────────

interface InputWindow extends Moment {
  readonly chars: number;
  readonly keys: number;
  readonly pointerEvents: number;
  readonly injections: number;
  readonly idlePointerInjections: number;
}

class TypingProfile {
  readonly keystrokes: number[];
  readonly windows: InputWindow[];
  readonly injectedAt: number[];
  readonly revisions: { at: number; added: number }[];
  readonly burstKeystrokes: number;
  readonly burstChars: number;

  constructor(rows: TimelineRows, flags: readonly FlagEvent[], start: number) {
    this.keystrokes = rows.keystrokes
      .map((k) => parseMs(k.created_at))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);
    this.windows = rows.input.flatMap((w) => {
      const at = parseMs(w.window_start);
      return at === null
        ? []
        : [
            {
              at,
              end: at + Math.max(0, w.window_ms),
              chars: w.chars,
              keys: w.keys,
              pointerEvents: w.pointer_events,
              injections: w.injections,
              idlePointerInjections: w.idle_pointer_injections,
            },
          ];
    });
    this.injectedAt = flags
      .filter((f) => f.name === 'text_injected' || f.name === 'burst_after_idle')
      .map((f) => f.at);
    const previous = new Map<string, number>();
    this.revisions = rows.revisions.flatMap((r) => {
      const at = parseMs(r.created_at);
      const before = previous.get(r.question_version_id) ?? 0;
      previous.set(r.question_version_id, r.word_count);
      return at === null ? [] : [{ at, added: r.word_count - before }];
    });

    // The student's own first minutes set how much typing is "a burst" for them.
    const baseline: Moment = { at: start, end: start + T.baselineMs };
    const per = T.notes.followMs / T.baselineMs;
    const baseKeys = this.keystrokes.filter((t) => t >= baseline.at && t <= baseline.end).length;
    const baseChars = this.windows
      .filter((w) => overlaps(w, baseline))
      .reduce((sum, w) => sum + w.chars, 0);
    this.burstKeystrokes = Math.max(
      T.typingBurst.minKeystrokes,
      Math.round(baseKeys * per * T.typingBurst.baselineMultiplier),
    );
    this.burstChars = Math.max(
      T.typingBurst.minChars,
      Math.round(baseChars * per * T.typingBurst.baselineMultiplier),
    );
  }

  /** True when a burst of typing (or text appearing at once) falls inside the span. */
  burstWithin(span: Moment): boolean {
    if (this.injectedAt.some((t) => t >= span.at && t <= span.end)) return true;
    if (
      this.revisions.some(
        (r) => r.at >= span.at && r.at <= span.end && r.added >= T.typingBurst.revisionWords,
      )
    ) {
      return true;
    }
    let keys = 0;
    for (const t of this.keystrokes) {
      if (t > span.end) break;
      if (t >= span.at) keys += 1;
    }
    if (keys >= this.burstKeystrokes) return true;
    return this.windows.some((w) => overlaps(w, span) && w.chars >= this.burstChars);
  }

  /** True when every window overlapping the span shows a still pointer (and one exists). */
  pointerStillDuring(span: Moment): boolean {
    const covering = this.windows.filter((w) => overlaps(w, span));
    return (
      covering.length > 0 &&
      covering.every((w) => w.pointerEvents <= T.answerEntry.stillPointerEvents)
    );
  }
}

// ── notes_or_second_screen ───────────────────────────────────────────────────

interface Glance extends Moment {
  readonly direction: string;
  readonly yaw: number | null;
  readonly pitch: number | null;
}

interface Cluster {
  readonly direction: string;
  yaw: number;
  pitch: number;
  readonly glances: Glance[];
}

const GAZE_DIRECTIONS = new Set(['left', 'right', 'up', 'down', 'away']);
const DIRECTION_TEXT: Record<string, string> = {
  left: 'to the left',
  right: 'to the right',
  up: 'upwards',
  down: 'downwards',
  away: 'away from the screen',
};

/** Greedy clustering: a glance joins the first region within ± regionDegrees on both axes. */
function clusterGlances(rows: TimelineRows): Cluster[] {
  const clusters: Cluster[] = [];
  for (const row of rows.gaze) {
    if (!GAZE_DIRECTIONS.has(row.direction)) continue;
    const at = parseMs(row.off_screen_start);
    if (at === null) continue;
    const glance: Glance = {
      at,
      end: at + row.duration_ms,
      direction: row.direction,
      yaw: row.yaw,
      pitch: row.pitch,
    };
    const hasAngles = row.yaw !== null || row.pitch !== null;
    const yaw = row.yaw ?? 0;
    const pitch = row.pitch ?? 0;
    let cluster = clusters.find((c) =>
      hasAngles
        ? Math.abs(c.yaw - yaw) <= T.notes.regionDegrees &&
          Math.abs(c.pitch - pitch) <= T.notes.regionDegrees
        : c.direction === row.direction,
    );
    if (cluster === undefined) {
      cluster = { direction: row.direction, yaw, pitch, glances: [] };
      clusters.push(cluster);
    }
    // Running centroid keeps the region anchored where the student actually looks.
    const n = cluster.glances.length;
    cluster.yaw = (cluster.yaw * n + yaw) / (n + 1);
    cluster.pitch = (cluster.pitch * n + pitch) / (n + 1);
    cluster.glances.push(glance);
  }
  return clusters;
}

function notesFinding(
  rows: TimelineRows,
  typing: TypingProfile,
  start: number,
  lastAt: number,
): Candidate | null {
  let best: Candidate | null = null;
  let bestFollowed = 0;
  const examMinutes = Math.max(1, (lastAt - start) / 60_000);
  const baselineMinutes = Math.min(examMinutes, T.baselineMs / 60_000);
  for (const cluster of clusterGlances(rows)) {
    if (cluster.glances.length < T.notes.minGlances) continue;
    const followed = cluster.glances.filter((g) =>
      typing.burstWithin({ at: g.end, end: g.end + T.notes.followMs }),
    );
    if (followed.length < T.notes.minFollowedByTyping || followed.length <= bestFollowed) continue;
    const injected = followed.filter((g) =>
      typing.injectedAt.some((t) => t >= g.end && t <= g.end + T.notes.followMs),
    ).length;
    const inBaseline = followed.filter((g) => g.at < start + T.baselineMs).length;
    const habit =
      inBaseline >= T.notes.habitBaselineGlances &&
      inBaseline / baselineMinutes >= (followed.length / examMinutes) * T.notes.habitRateRatio;
    if (habit) continue;
    const where = DIRECTION_TEXT[cluster.direction] ?? DIRECTION_TEXT.away!;
    const reasons = [
      `The student looked ${where} towards about the same spot ${plural(cluster.glances.length, 'time')}.`,
      `${plural(followed.length, 'of those glances was', 'of those glances were')} followed within ${seconds(T.notes.followMs)} by a burst of typing${injected > 0 ? ` (${injected} by text that appeared at once)` : ''}.`,
      inBaseline === 0
        ? `This pattern did not appear in the first ${Math.round(T.baselineMs / 60_000)} minutes of the attempt.`
        : 'This is more frequent than in the first minutes of the attempt.',
      'Notes, a second screen, or simply a habit of looking away while thinking could explain it.',
    ];
    bestFollowed = followed.length;
    best = {
      type: 'notes_or_second_screen',
      confidence:
        followed.length >= T.notes.highFollowedByTyping || injected > 0 ? 'high' : 'medium',
      title: 'Repeated glances to the same spot, then typing',
      reasons,
      moments: followed.map((g) => ({ at: g.at, end: g.end + T.notes.followMs })),
    };
  }
  return best;
}

// ── second_person ────────────────────────────────────────────────────────────

function secondPersonFinding(rows: TimelineRows): Candidate | null {
  const faceEpisodes: Moment[] = [];
  const noFace: Moment[] = [];
  for (const row of rows.gaze) {
    const at = parseMs(row.off_screen_start);
    if (at === null) continue;
    const m = { at, end: at + row.duration_ms };
    if (row.direction === 'multiple_faces' && row.duration_ms >= T.secondPerson.minFaceEpisodeMs) {
      faceEpisodes.push(m);
    } else if (row.direction === 'no_face') {
      noFace.push(m);
    }
  }
  const longest = Math.max(0, ...faceEpisodes.map((m) => m.end - m.at));
  const facesQualify =
    faceEpisodes.length >= T.secondPerson.minFaceEpisodes ||
    longest >= T.secondPerson.longFaceEpisodeMs;

  const transcripts = rows.transcripts.flatMap((t) => {
    const at = parseMs(t.captured_at);
    const words = t.text.trim() === '' ? 0 : t.text.trim().split(/\s+/u).length;
    return at === null || words < T.secondPerson.minTranscriptWords ? [] : [at];
  });
  const speechPairs: Moment[] = [];
  for (const row of rows.voice) {
    const at = parseMs(row.detected_at);
    if (at === null || row.duration_ms < T.secondPerson.minVoiceMs) continue;
    const voice = { at, end: at + row.duration_ms };
    const facePresent = !noFace.some((m) => overlaps(m, voice));
    if (!facePresent) continue;
    const near = transcripts.find(
      (t) =>
        t >= voice.at - T.secondPerson.voiceTranscriptGapMs &&
        t <= voice.end + T.secondPerson.voiceTranscriptGapMs,
    );
    if (near === undefined) continue;
    speechPairs.push({ at: Math.min(voice.at, near), end: Math.max(voice.end, near) });
  }

  if (!facesQualify && speechPairs.length === 0) return null;
  const reasons: string[] = [];
  if (facesQualify) {
    reasons.push(
      `More than one face was in view of the camera ${plural(faceEpisodes.length, 'time')} (longest ${seconds(longest)}).`,
    );
  }
  if (speechPairs.length > 0) {
    reasons.push(
      `Speech was heard and transcribed ${plural(speechPairs.length, 'time')} while the student's face stayed in view.`,
    );
  }
  reasons.push(
    'Someone passing by, a family member, or the student reading aloud could explain this.',
  );
  const confidence: FindingConfidence =
    facesQualify && speechPairs.length > 0
      ? 'high'
      : facesQualify || speechPairs.length >= T.secondPerson.mediumSpeechPairs
        ? 'medium'
        : 'low';
  return {
    type: 'second_person',
    confidence,
    title: 'Signs of another person in the room',
    reasons,
    moments: [...(facesQualify ? faceEpisodes : []), ...speechPairs],
  };
}

// ── external_answer_entry ────────────────────────────────────────────────────

function answerEntryFinding(flags: readonly FlagEvent[], typing: TypingProfile): Candidate | null {
  const injectionMoments: Moment[] = [
    ...flags.filter((f) => f.name === 'text_injected').map((f) => ({ at: f.at, end: f.at })),
    ...typing.windows.filter((w) => w.injections > 0).map((w) => ({ at: w.at, end: w.end })),
  ];
  const episodes = mergeMoments(injectionMoments, T.answerEntry.episodeMergeMs);
  const stillInjection =
    typing.windows.some((w) => w.idlePointerInjections > 0) ||
    flags.some(
      (f) => f.name === 'text_injected' && typing.pointerStillDuring({ at: f.at, end: f.at }),
    );
  const stillBursts = flags
    .filter(
      (f) =>
        f.name === 'burst_after_idle' &&
        typing.pointerStillDuring({ at: f.at - T.answerEntry.idleLookbackMs, end: f.at }),
    )
    .map((f) => ({ at: f.at - T.answerEntry.idleLookbackMs, end: f.at }));

  let confidence: FindingConfidence | null = null;
  if (episodes.length >= 2) confidence = stillInjection ? 'high' : 'medium';
  else if (episodes.length === 1 && stillInjection) confidence = 'medium';
  if (stillBursts.length > 0) {
    if (episodes.length > 0) confidence = 'high';
    else if (confidence === null) confidence = stillBursts.length >= 2 ? 'medium' : 'low';
  }
  if (confidence === null) return null;

  const reasons: string[] = [];
  if (episodes.length > 0) {
    reasons.push(
      `A long stretch of answer text appeared at once ${plural(episodes.length, 'time')}${stillInjection ? ' while the mouse was still' : ''}.`,
    );
  }
  if (stillBursts.length > 0) {
    reasons.push(
      `${plural(stillBursts.length, 'long answer was', 'long answers were')} typed quickly after a long pause with no mouse or keyboard activity.`,
    );
  }
  reasons.push(
    'Dictation, a text expander, assistive tools, or a prepared outline typed from memory can look like this.',
  );
  return {
    type: 'external_answer_entry',
    confidence,
    title: 'Answer text that appeared at once',
    reasons,
    moments: [...episodes, ...stillBursts],
  };
}

// ── phone_use ────────────────────────────────────────────────────────────────

function phoneFinding(rows: TimelineRows, flags: readonly FlagEvent[]): Candidate | null {
  const detections = mergeMoments(
    flags
      .filter(
        (f) =>
          f.name === 'phone_detected' || (f.name.startsWith('vision_') && f.name.includes('phone')),
      )
      .map((f) => ({ at: f.at, end: f.at })),
    T.phone.detectionMergeMs,
  );
  const phoneAway = flags.filter((f) => f.name === 'iphone_lost' || f.name === 'phone_left_app');
  const downGazes = rows.gaze.flatMap((g) => {
    const at = parseMs(g.off_screen_start);
    return at === null || g.direction !== 'down' || g.duration_ms < T.phone.minDownGazeMs
      ? []
      : [{ at, end: at + g.duration_ms }];
  });
  const nearby = (m: Moment, events: readonly { at: number; end?: number }[]): boolean =>
    events.some(
      (e) =>
        (e.end ?? e.at) >= m.at - T.phone.correlationMs && e.at <= m.end + T.phone.correlationMs,
    );
  const pairs = downGazes.filter((g) => nearby(g, phoneAway));
  const corroboratedDetections = detections.filter(
    (d) => nearby(d, downGazes) || nearby(d, phoneAway),
  );

  let confidence: FindingConfidence | null = null;
  if (pairs.length > 0) confidence = corroboratedDetections.length > 0 ? 'high' : 'medium';
  else if (corroboratedDetections.length > 0) confidence = 'medium';
  else if (detections.length >= T.phone.minDetections) confidence = 'medium';
  if (confidence === null) return null;

  const reasons: string[] = [];
  if (detections.length > 0) {
    reasons.push(
      `The camera check reported a possible phone in view ${plural(detections.length, 'time')}.`,
    );
  }
  if (pairs.length > 0) {
    reasons.push(
      `The student looked down for ${seconds(T.phone.minDownGazeMs)} or more ${plural(pairs.length, 'time')} around the moment the paired iPhone stopped answering or left the app.`,
    );
  } else if (corroboratedDetections.length > 0) {
    reasons.push(
      'Around the same time the student looked down for a while or the paired iPhone stopped answering.',
    );
  }
  reasons.push(
    'A calculator, a glance at the desk, or a locked phone with a dropped connection can look similar.',
  );
  return {
    type: 'phone_use',
    confidence,
    title: 'Possible phone use',
    reasons,
    moments: [
      ...pairs,
      ...detections,
      ...phoneAway
        .filter((e) => pairs.some((p) => nearby(p, [e])))
        .map((e) => ({ at: e.at, end: e.at })),
    ],
  };
}

// ── left_exam ────────────────────────────────────────────────────────────────

const LEAVE_EVENTS: Record<string, string> = {
  focus_lost: 'the exam window lost focus',
  page_hidden: 'the exam tab was hidden',
  window_minimize_blocked: 'a minimize was blocked',
  fullscreen_exit_blocked: 'leaving full screen was blocked',
  screen_recording_stopped: 'screen recording stopped',
  lockdown_emergency_exit: 'the lockdown emergency exit was used',
  foreground_app: 'another app was in front',
};

function leftExamFinding(flags: readonly FlagEvent[]): Candidate | null {
  const leaves = flags.filter((f) => LEAVE_EVENTS[f.name] !== undefined);
  const presenceFailures = flags.filter((f) => f.name === 'presence_check_failed');
  const counted =
    presenceFailures.length >= T.leftExam.presenceFailures
      ? [...leaves, ...presenceFailures]
      : leaves;
  const episodes = mergeMoments(
    counted.map((f) => ({ at: f.at, end: f.at })),
    T.leftExam.episodeMergeMs,
  );
  if (episodes.length < T.leftExam.minEpisodes) return null;

  const kinds = new Map<string, number>();
  for (const f of leaves) kinds.set(f.name, (kinds.get(f.name) ?? 0) + 1);
  const emergency = kinds.has('lockdown_emergency_exit');
  const confidence: FindingConfidence =
    episodes.length >= T.leftExam.highEpisodes || emergency
      ? 'high'
      : episodes.length >= T.leftExam.mediumEpisodes
        ? 'medium'
        : 'low';
  const detail = [...kinds.entries()].map(([name, n]) => `${LEAVE_EVENTS[name]} (${n})`).join(', ');
  const reasons = [
    `The exam was left or interrupted ${plural(episodes.length, 'time')}${detail === '' ? '' : `: ${detail}`}.`,
  ];
  if (presenceFailures.length >= T.leftExam.presenceFailures) {
    reasons.push(
      `Presence spot checks could not confirm the student ${plural(presenceFailures.length, 'time')}.`,
    );
  }
  reasons.push(
    'Notifications, an accidental keyboard shortcut, or a dropped screen share can cause this too.',
  );
  return {
    type: 'left_exam',
    confidence,
    title: 'Left or interrupted the exam several times',
    reasons,
    moments: episodes,
  };
}

// ── environment_risk ─────────────────────────────────────────────────────────

const ENVIRONMENT_TEXT: Record<string, string> = {
  camera_swapped_to_virtual: 'the active camera looked like a virtual camera',
  virtual_camera_connected: 'a virtual camera device appeared',
  capture_device_connected: 'a video-capture device appeared',
  capture_display_connected:
    'a display that looks like capture or mirroring hardware was connected',
  camera_feed_paused_virtual_camera: 'the camera feed paused because a virtual camera was selected',
  camera_feed_paused_virtual_camera_attested:
    'the camera feed paused because macOS reported a virtual camera',
  camera_unverified: 'the camera hardware could not be verified',
  multiple_displays: 'more than one display was connected',
};

function environmentFinding(flags: readonly FlagEvent[]): Candidate | null {
  const strong = flags.filter((f) => T.environment.strong.includes(f.name));
  const weak = flags.filter((f) => T.environment.weak.includes(f.name));
  const strongKinds = new Set(strong.map((f) => f.name));
  const weakKinds = new Set(weak.map((f) => f.name));

  let confidence: FindingConfidence | null = null;
  if (strong.length > 0) {
    confidence =
      strongKinds.size >= 2 || strong.length >= T.environment.highStrongEvents || weak.length > 0
        ? 'high'
        : 'medium';
  } else if (weakKinds.size >= 2) {
    confidence = 'low';
  }
  if (confidence === null) return null;

  const seen = [...strongKinds, ...weakKinds].map((name) => ENVIRONMENT_TEXT[name] ?? name);
  return {
    type: 'environment_risk',
    confidence,
    title: 'Camera or display setup worth checking',
    reasons: [
      `During the attempt ${seen.join('; ')}.`,
      'Streaming software, a docking station, or a second monitor used for something permitted can trigger these.',
    ],
    moments: [...strong, ...weak].map((f) => ({ at: f.at, end: f.at })),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function toWindows(moments: readonly Moment[], fallback: number): FindingWindow[] {
  const merged = mergeMoments(
    moments.length === 0 ? [{ at: fallback, end: fallback }] : moments,
    T.windowMergeMs,
  );
  return merged.slice(0, T.maxWindows).map((m) => ({ start: iso(m.at), end: iso(m.end) }));
}

function finalize(candidate: Candidate, rows: TimelineRows, fallback: number): Finding {
  const windows = toWindows(candidate.moments, fallback);
  const spans = windows.map((w) => ({ at: Date.parse(w.start), end: Date.parse(w.end) }));
  const within = (t: number, pad: number) => spans.some((s) => t >= s.at - pad && t <= s.end + pad);
  const evidenceIds = rows.evidence
    .filter((e) => {
      const t = parseMs(e.captured_at);
      return t !== null && within(t, T.evidencePadMs);
    })
    .map((e) => e.id);
  const transcript = rows.transcripts.flatMap((line) => {
    const t = parseMs(line.captured_at);
    return t !== null && within(t, 0) ? [{ at: iso(t), text: line.text }] : [];
  });
  return {
    id: `${candidate.type}:${windows[0]!.start}`,
    type: candidate.type,
    confidence: candidate.confidence,
    title: candidate.title,
    reasons: candidate.reasons,
    windows,
    evidenceIds,
    transcript,
    studentNote: null,
  };
}

export function reviewLevel(findings: readonly Pick<Finding, 'confidence'>[]): ReviewLevel {
  if (findings.length === 0) return 'none';
  const high = findings.some((f) => f.confidence === 'high');
  const medium = findings.filter((f) => f.confidence === 'medium').length;
  return high || medium >= 2 ? 'review' : 'glance';
}

/** Last stored moment of the attempt, so rates are per minute of actual activity. */
function lastActivity(rows: TimelineRows, start: number): number {
  const times = [
    rows.meta.submittedAt,
    rows.meta.expiredAt,
    ...rows.gaze.map((r) => r.off_screen_start),
    ...rows.apps.map((r) => r.created_at),
    ...rows.keystrokes.map((r) => r.created_at),
    ...rows.input.map((r) => r.window_start),
    ...rows.revisions.map((r) => r.created_at),
  ]
    .filter((v): v is string => v !== null)
    .map(parseMs)
    .filter((t): t is number => t !== null);
  return Math.max(start, ...times);
}

export function buildFindings(rows: TimelineRows): AttemptFindings {
  const start = parseMs(rows.meta.startedAt) ?? 0;
  const flags = flagEvents(rows);
  const typing = new TypingProfile(rows, flags, start);
  const lastAt = lastActivity(rows, start);

  const candidates = [
    notesFinding(rows, typing, start, lastAt),
    secondPersonFinding(rows),
    answerEntryFinding(flags, typing),
    phoneFinding(rows, flags),
    leftExamFinding(flags),
    environmentFinding(flags),
  ].filter((c): c is Candidate => c !== null);

  const rank = (c: Candidate) => T.priority.indexOf(c.type);
  candidates.sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || rank(a) - rank(b),
  );
  const findings = candidates.slice(0, 6).map((c) => finalize(c, rows, start));
  return {
    attemptId: rows.meta.id,
    level: reviewLevel(findings),
    findings,
    topReason: findings[0]?.title ?? null,
  };
}
