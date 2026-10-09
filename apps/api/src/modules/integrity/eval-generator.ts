import type { FindingType } from '@examguard/contracts/findings';

import type { InputWindowRow, TimelineRows } from './integrityRepository.js';

/**
 * Seeded generator for the findings evaluation set (`eval-sessions/*.json`, replayed by
 * `npm run eval:findings`).
 *
 * Each scenario describes one attempt as behaviours on a timeline. The builder turns them into
 * the same raw rows the API stores (`TimelineRows`): keystrokes one by one, 20 s input-behaviour
 * windows aggregated from those keystrokes plus a pointer model, gaze rows, named app-event flags,
 * voice and transcript rows, answer revisions and evidence metadata. The client-side
 * `burst_after_idle` event is reproduced by a small simulated detector so it appears wherever the
 * typing itself warrants it, in honest and staged sessions alike.
 *
 * Everything is deterministic for a seed (mulberry32, one stream per scenario), but noisy on
 * purpose so the set cannot be matched by fixed timings: timestamps jitter, the gaze tracker misses
 * glances, episodes are sometimes only partly logged, and honest sessions carry the same background
 * noise (short look-aways, face loss, app heartbeats) as staged ones. The thresholds in
 * `findings.ts` were not adjusted against this set; see docs/eval-findings.md.
 */

export type EvalCohort = 'honest' | 'cheat' | 'hard_honest' | 'hard_cheat';

export interface EvalSession {
  readonly id: string;
  readonly cohort: EvalCohort;
  readonly description: string;
  /** Finding types a staged cheat should produce (empty for honest sessions). */
  readonly expected: readonly FindingType[];
  readonly rows: TimelineRows;
}

export const EVAL_SEED = 20_260_915;
const START_MS = Date.parse('2026-09-15T09:00:00.000Z');
const WINDOW_MS = 20_000;
const QUESTIONS = 8;

/** FNV-1a, so each scenario gets its own stream and adding one does not reshuffle the others. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Box-Muller normal deviate. */
  gauss(mean: number, sd: number): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
    if (item === undefined) throw new Error('pick() needs a non-empty list');
    return item;
  }
}

interface Span {
  readonly at: number;
  readonly end: number;
}

interface TypistProfile {
  readonly keysPerSec: number;
  /** Mean seconds thinking between typing spans. */
  readonly thinkS: number;
  /** Mean seconds of one typing span. */
  readonly typeS: number;
}

export const TYPISTS = {
  steady: { keysPerSec: 2.2, thinkS: 28, typeS: 18 },
  slow: { keysPerSec: 1.0, thinkS: 40, typeS: 25 },
  fast: { keysPerSec: 6.0, thinkS: 75, typeS: 12 },
  /** Types little because answers arrive another way. */
  sparse: { keysPerSec: 2.0, thinkS: 70, typeS: 8 },
} as const satisfies Record<string, TypistProfile>;

type GazeRow = TimelineRows['gaze'][number];
type AppRow = TimelineRows['apps'][number];
type KeystrokeRow = TimelineRows['keystrokes'][number];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** One attempt under construction; all times are seconds since the attempt started. */
export class AttemptBuilder {
  private readonly keystrokes: { t: number; q: string }[] = [];
  private readonly gaze: GazeRow[] = [];
  private readonly apps: AppRow[] = [];
  private readonly voiceRows: TimelineRows['voice'][number][] = [];
  private readonly transcriptRows: TimelineRows['transcripts'][number][] = [];
  private readonly evidenceRows: TimelineRows['evidence'][number][] = [];
  private readonly livenessRows: TimelineRows['liveness'][number][] = [];
  private readonly revisionRows: { t: number; q: string; words: number }[] = [];
  private readonly injections: { t: number; chars: number; still: boolean }[] = [];
  private readonly idleSpans: Span[] = [];
  private readonly words = new Map<string, number>();

  constructor(
    readonly rng: Rng,
    readonly durationS: number,
  ) {}

  iso(sec: number): string {
    return new Date(START_MS + Math.round(sec * 1000)).toISOString();
  }

  /** Students move through the questions roughly in order. */
  question(sec: number): string {
    return `q${1 + clamp(Math.floor((sec / this.durationS) * QUESTIONS), 0, QUESTIONS - 1)}`;
  }

  private inIdle(sec: number): boolean {
    return this.idleSpans.some((s) => sec >= s.at && sec <= s.end);
  }

  /** Honest think/type cycles for the whole attempt (explicit idle spans stay silent). */
  typist(profile: TypistProfile): this {
    let t = this.rng.range(5, 20);
    while (t < this.durationS - 10) {
      t += Math.max(3, this.rng.gauss(profile.thinkS, profile.thinkS * 0.4));
      const span = Math.max(3, this.rng.gauss(profile.typeS, profile.typeS * 0.4));
      this.type(t, span, profile.keysPerSec);
      t += span;
    }
    return this;
  }

  /** Keystrokes at about `keysPerSec` for `spanS` seconds; returns how many were typed. */
  type(sec: number, spanS: number, keysPerSec: number): number {
    const q = this.question(sec);
    let t = sec;
    let keys = 0;
    while (t < sec + spanS && t < this.durationS) {
      if (this.inIdle(t)) {
        t += 1;
        continue;
      }
      this.keystrokes.push({ t, q });
      keys += 1;
      const interval = Math.max(0.045, this.rng.gauss(1 / keysPerSec, 0.4 / keysPerSec));
      t += interval + (this.rng.chance(0.05) ? this.rng.range(0.5, 2.5) : 0);
    }
    if (keys > 0) this.revise(t, q, Math.round(keys * 0.17));
    return keys;
  }

  /** A quick stretch of typing, e.g. copying something just read. */
  burst(sec: number, keys: number, spanS: number): this {
    this.type(sec, spanS, Math.max(0.5, keys / spanS));
    return this;
  }

  /**
   * Hands off keyboard and mouse: no keystrokes, pointer windows at zero. Typing already laid
   * down inside the span (e.g. by `typist()`) is removed so call order does not matter.
   */
  idle(sec: number, end: number): this {
    this.idleSpans.push({ at: sec, end });
    const inside = (t: number) => t >= sec && t <= end;
    for (let i = this.keystrokes.length - 1; i >= 0; i -= 1) {
      if (inside(this.keystrokes[i]!.t)) this.keystrokes.splice(i, 1);
    }
    for (let i = this.revisionRows.length - 1; i >= 0; i -= 1) {
      if (inside(this.revisionRows[i]!.t)) this.revisionRows.splice(i, 1);
    }
    return this;
  }

  private revise(sec: number, q: string, added: number): void {
    const total = (this.words.get(q) ?? 0) + added;
    this.words.set(q, total);
    this.revisionRows.push({ t: sec, q, words: total });
  }

  /** Text that appeared at once (paste or injected); `still` keeps the pointer motionless. */
  inject(sec: number, chars: number, still: boolean): this {
    this.injections.push({ t: sec, chars, still });
    this.flag(sec + this.rng.range(0.1, 0.8), 'text_injected');
    if (still) this.idle(sec - 25, sec + 3);
    this.revise(sec + 1, this.question(sec), Math.round(chars / 5.5));
    return this;
  }

  glance(sec: number, durS: number, direction: string, yaw: number | null, pitch: number | null) {
    const at = sec + this.rng.gauss(0, 0.3);
    this.gaze.push({
      off_screen_start: this.iso(at),
      duration_ms: Math.round(Math.max(300, durS * 1000 + this.rng.gauss(0, 150))),
      direction,
      yaw: yaw === null ? null : Math.round(yaw * 10) / 10,
      pitch: pitch === null ? null : Math.round(pitch * 10) / 10,
    });
    return this;
  }

  /**
   * Repeated glances to one region: `count` of them from `fromS` spaced `gapS` apart, each
   * logged with probability `1 - missRate`, and with probability `typeAfter.p` followed by
   * typing of about `typeAfter.keys` keystrokes.
   */
  glances(options: {
    fromS: number;
    count: number;
    gapS: number;
    direction: string;
    yaw: number;
    pitch: number;
    durS: readonly [number, number];
    missRate?: number;
    typeAfter?: { p: number; keys: number; spanS: number };
  }): this {
    let t = options.fromS;
    for (let i = 0; i < options.count; i += 1) {
      const dur = this.rng.range(options.durS[0], options.durS[1]);
      const missed = this.rng.chance(options.missRate ?? 0);
      if (!missed && t < this.durationS - 5) {
        // The tracker sometimes catches only the tail of a glance.
        const logged = this.rng.chance(0.15) ? dur * this.rng.range(0.3, 0.6) : dur;
        this.glance(
          t,
          logged,
          options.direction,
          this.rng.gauss(options.yaw, 2.5),
          this.rng.gauss(options.pitch, 2.5),
        );
      }
      const after = options.typeAfter;
      if (after !== undefined && this.rng.chance(after.p)) {
        const keys = Math.max(3, Math.round(this.rng.gauss(after.keys, after.keys * 0.2)));
        this.burst(t + dur + this.rng.range(0.5, 2), keys, after.spanS);
      }
      t += Math.max(5, this.rng.gauss(options.gapS, options.gapS * 0.3));
    }
    return this;
  }

  flag(sec: number, name: string): this {
    this.apps.push({ created_at: this.iso(sec), foreground_app: `flag:${name}`, display_count: 1 });
    return this;
  }

  /** Another application was in front (the desktop app reports its name). */
  foregroundApp(sec: number, name: string): this {
    this.apps.push({ created_at: this.iso(sec), foreground_app: name, display_count: 1 });
    return this;
  }

  displays(sec: number, count: number): this {
    this.apps.push({ created_at: this.iso(sec), foreground_app: '', display_count: count });
    return this;
  }

  voice(sec: number, durS: number, peakDb = -28): this {
    this.voiceRows.push({
      detected_at: this.iso(sec + this.rng.gauss(0, 0.2)),
      duration_ms: Math.round(Math.max(200, durS * 1000 + this.rng.gauss(0, 120))),
      peak_db: Math.round(peakDb + this.rng.gauss(0, 3)),
    });
    return this;
  }

  transcript(sec: number, text: string): this {
    this.transcriptRows.push({ captured_at: this.iso(sec + this.rng.range(0.5, 4)), text });
    return this;
  }

  snapshot(sec: number, trigger: string, source = 'camera'): this {
    this.evidenceRows.push({
      id: `ev-${this.evidenceRows.length + 1}`,
      source,
      trigger,
      captured_at: this.iso(sec + this.rng.range(0, 2)),
    });
    return this;
  }

  liveness(sec: number, layer: number, result: string): this {
    this.livenessRows.push({
      created_at: this.iso(sec),
      layer,
      result,
      details_json: JSON.stringify({ synthetic: true }),
    });
    return this;
  }

  /** Background noise every session has: stray look-aways, face-loss blips, app heartbeats. */
  noise(): this {
    this.liveness(this.rng.range(2, 8), 1, 'passed');
    for (let t = 60; t < this.durationS; t += 60) this.displays(t + this.rng.gauss(0, 2), 1);
    for (let t = this.rng.range(20, 200); t < this.durationS; t += this.rng.gauss(180, 70)) {
      this.glance(
        t,
        this.rng.range(0.8, 2.5),
        this.rng.pick(['left', 'right', 'up', 'down', 'away']),
        this.rng.gauss(0, 25),
        this.rng.gauss(0, 15),
      );
    }
    for (let t = this.rng.range(100, 500); t < this.durationS; t += this.rng.gauss(480, 150)) {
      this.glance(t, this.rng.range(0.4, 1.2), 'no_face', null, null);
    }
    return this;
  }

  /**
   * Simulated client detector: a long silence followed by fast typing is reported as
   * `burst_after_idle`, as the web app does, honest or not.
   */
  private detectBursts(sorted: readonly { t: number }[]): void {
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i]!;
      if (current.t - sorted[i - 1]!.t < 120) continue;
      const inFirst15 = sorted.filter((k) => k.t >= current.t && k.t <= current.t + 15).length;
      if (inFirst15 >= 40) this.flag(current.t + this.rng.range(8, 12), 'burst_after_idle');
    }
  }

  private inputWindows(sorted: readonly { t: number }[]): InputWindowRow[] {
    const rows: InputWindowRow[] = [];
    for (let start = 0; start < this.durationS; start += WINDOW_MS / 1000) {
      const end = start + WINDOW_MS / 1000;
      const keys = sorted.filter((k) => k.t >= start && k.t < end).length;
      const injected = this.injections.filter((i) => i.t >= start && i.t < end);
      const injectedChars = injected.reduce((sum, i) => sum + i.chars, 0);
      const corrections = Math.round(keys * 0.06 * this.rng.range(0.5, 1.5));
      const chars = Math.max(0, keys - corrections * 2) + injectedChars;
      const idle = this.idleSpans.some((s) => start <= s.end && s.at <= end);
      const pointerEvents = idle
        ? 0
        : keys > 0
          ? Math.max(2, Math.round(this.rng.gauss(22, 8)))
          : this.rng.chance(0.1)
            ? 0
            : Math.max(0, Math.round(this.rng.gauss(9, 6)));
      rows.push({
        window_start: this.iso(start),
        window_ms: WINDOW_MS,
        pointer_events: pointerEvents,
        pointer_leaves: 0,
        pointer_outside_ms: 0,
        longest_outside_ms: 0,
        outside_edge: null,
        untrusted_events: 0,
        teleports: 0,
        robotic_segments: 0,
        path_straightness: null,
        velocity_cv: null,
        context_menus: 0,
        selections: 0,
        keys,
        chars,
        corrections,
        mean_dwell_ms: keys > 0 ? Math.round(this.rng.gauss(95, 10)) : null,
        mean_interval_ms: keys > 1 ? Math.round((WINDOW_MS / keys) * this.rng.range(0.6, 1)) : null,
        interval_cv: keys > 1 ? Math.round(this.rng.range(0.3, 0.7) * 100) / 100 : null,
        wpm: Math.round((chars / 5 / (WINDOW_MS / 60_000)) * 10) / 10,
        injections: injected.length,
        idle_pointer_injections: injected.filter((i) => i.still).length,
        drift_z_dwell: null,
        drift_z_interval: null,
      });
    }
    return rows;
  }

  build(id: string): TimelineRows {
    const sorted = [...this.keystrokes].sort((a, b) => a.t - b.t);
    this.detectBursts(sorted);
    const byTime = <T>(items: readonly T[], key: (item: T) => string): T[] =>
      [...items].sort((a, b) => key(a).localeCompare(key(b)));
    const keystrokes: KeystrokeRow[] = sorted.map((k) => ({
      created_at: this.iso(k.t),
      question_version_id: k.q,
      dwell_ms: Math.round(clamp(this.rng.gauss(95, 25), 40, 220)),
      flight_ms: Math.round(clamp(this.rng.gauss(190, 70), 30, 900)),
    }));
    return {
      meta: {
        id,
        status: 'submitted',
        startedAt: this.iso(0),
        submittedAt: this.iso(this.durationS),
        expiredAt: null,
        studentId: 'eval-student',
      },
      gaze: byTime(this.gaze, (r) => r.off_screen_start),
      apps: byTime(this.apps, (r) => r.created_at),
      keystrokes,
      input: this.inputWindows(sorted),
      voice: byTime(this.voiceRows, (r) => r.detected_at),
      liveness: byTime(this.livenessRows, (r) => r.created_at),
      transcripts: byTime(this.transcriptRows, (r) => r.captured_at),
      revisions: byTime(
        this.revisionRows.map((r) => ({
          created_at: this.iso(r.t),
          question_version_id: r.q,
          word_count: r.words,
        })),
        (r) => r.created_at,
      ),
      phones: [{ created_at: this.iso(-30), last_seen_at: this.iso(this.durationS) }],
      audits: [],
      evidence: byTime(this.evidenceRows, (r) => r.captured_at),
    };
  }
}

interface Scenario {
  readonly id: string;
  readonly cohort: EvalCohort;
  readonly description: string;
  readonly expected: readonly FindingType[];
  readonly build: (b: AttemptBuilder) => void;
}

const TV_LINES = [
  'and now a look at the weather for tonight',
  'tomorrow will be mostly sunny with a high of twenty nine',
  'back after these messages from our sponsors',
];

const HELPER_LINES = [
  'number three is the mitochondria not the nucleus',
  'no wait check the second one again',
  'write that the main cause was the trade routes',
  'you can just copy what I said',
];

const READ_ALOUD_LINES = [
  'which of the following best describes the role of',
  'explain why the author uses this example okay so',
  'compare and contrast the two approaches hmm',
  'calculate the total cost given the following',
];

/** A single helper visit: faces and voice, with a part of it missed or only partly logged. */
function helperVisit(b: AttemptBuilder, fromS: number, lines: readonly string[]): void {
  let t = fromS;
  for (const [i, line] of lines.entries()) {
    const faceDur = b.rng.pick([1.4, 3, 6, 12]);
    if (!b.rng.chance(0.25)) b.glance(t, faceDur, 'multiple_faces', null, null);
    b.voice(t + b.rng.range(0.5, 2), b.rng.range(2.5, 6), -24);
    if (!b.rng.chance(0.2)) b.transcript(t + 1, line);
    if (i === 0) b.snapshot(t + 2, 'extra_person');
    t += b.rng.range(12, 30);
  }
}

const SCENARIOS: readonly Scenario[] = [
  // ── Honest ──────────────────────────────────────────────────────────────────
  {
    id: 'honest-thinking-up',
    cohort: 'honest',
    description:
      'Looks up at the ceiling while thinking, then types the sentence (from the start).',
    expected: [],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 25,
        count: 14,
        gapS: b.durationS / 15,
        direction: 'up',
        yaw: 0,
        pitch: 22,
        durS: [1.5, 4],
        missRate: 0.1,
        typeAfter: { p: 0.6, keys: 18, spanS: 8 },
      }),
  },
  {
    id: 'honest-calculator',
    cohort: 'honest',
    description:
      'Uses a desk calculator for the later questions (looks down 3-9 s, types a number).',
    expected: [],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 240,
        count: 8,
        gapS: 110,
        direction: 'down',
        yaw: 5,
        pitch: -28,
        durS: [3, 9],
        typeAfter: { p: 0.8, keys: 6, spanS: 3 },
      }),
  },
  {
    id: 'honest-slow-typist',
    cohort: 'honest',
    description: 'Slow hunt-and-peck typist with long pauses and nothing else going on.',
    expected: [],
    build: (b) => b.typist(TYPISTS.slow),
  },
  {
    id: 'honest-fast-typist',
    cohort: 'honest',
    description: 'Fast touch typist: reads for a minute or more, then writes the answer in one go.',
    expected: [],
    build: (b) => b.typist(TYPISTS.fast),
  },
  {
    id: 'honest-one-focus-loss',
    cohort: 'honest',
    description: 'A notification steals focus once (focus lost, page hidden, Finder in front).',
    expected: [],
    build: (b) => {
      const t = b.rng.range(400, 700);
      b.typist(TYPISTS.steady)
        .flag(t, 'focus_lost')
        .flag(t + 0.3, 'page_hidden');
      b.foregroundApp(t + 1.5, 'Finder');
    },
  },
  {
    id: 'honest-glasses-lighting',
    cohort: 'honest',
    description:
      'Glasses glare and a lamp switched on: face lost for a few seconds now and then, one failed presence pulse.',
    expected: [],
    build: (b) => {
      b.typist(TYPISTS.steady);
      for (let i = 0; i < 6; i += 1) {
        b.glance(b.rng.range(60, b.durationS - 60), b.rng.range(0.8, 3), 'no_face', null, null);
      }
      b.glance(b.rng.range(300, 900), 1.2, 'multiple_faces', null, null);
      const t = b.rng.range(500, 800);
      b.flag(t, 'presence_check_failed').flag(t + 45, 'presence_check_passed');
      b.liveness(t, 2, 'failed').liveness(t + 45, 2, 'passed');
    },
  },
  {
    id: 'honest-background-tv',
    cohort: 'honest',
    description:
      'A TV in the next room for about 45 s; the student keeps typing and the face never leaves view.',
    expected: [],
    build: (b) => {
      const t = b.rng.range(500, 900);
      b.typist(TYPISTS.steady);
      b.voice(t, 3.5, -34)
        .voice(t + 14, 2.6, -36)
        .voice(t + 31, 4.2, -33);
      b.transcript(t, TV_LINES[0]!).transcript(t + 30, TV_LINES[1]!);
    },
  },
  {
    id: 'honest-posture-shift',
    cohort: 'honest',
    description:
      'Leans to one side at minute 8: a run of short "right" look-aways until the gaze model recalibrates.',
    expected: [],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 480,
        count: 7,
        gapS: 13,
        direction: 'right',
        yaw: 11,
        pitch: -4,
        durS: [1, 2],
      }),
  },
  {
    id: 'honest-keyboard-looker',
    cohort: 'honest',
    description: 'Looks at the keyboard while typing from the very first question (a habit).',
    expected: [],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 12,
        count: 22,
        gapS: b.durationS / 23,
        direction: 'down',
        yaw: 0,
        pitch: -32,
        durS: [2, 4],
        missRate: 0.1,
        typeAfter: { p: 0.85, keys: 22, spanS: 8 },
      }),
  },

  // ── Staged cheats ───────────────────────────────────────────────────────────
  {
    id: 'cheat-notes-beside-screen',
    cohort: 'cheat',
    description: 'Notes taped left of the screen from minute 6: glance, then copy a line.',
    expected: ['notes_or_second_screen'],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 380,
        count: 13,
        gapS: 55,
        direction: 'left',
        yaw: -33,
        pitch: 6,
        durS: [2, 5],
        missRate: 0.2,
        typeAfter: { p: 0.75, keys: 55, spanS: 9 },
      }),
  },
  {
    id: 'cheat-phone-in-hand',
    cohort: 'cheat',
    description:
      'A second phone held below the desk three times; the camera sees it in some frames, the paired iPhone stays put.',
    expected: ['phone_use'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      for (const t of [300, 700, 1000].map((x) => x + b.rng.range(-60, 60))) {
        const dur = b.rng.range(6, 14);
        b.glance(t, dur, 'down', b.rng.gauss(8, 3), -35);
        for (let i = 0; i < b.rng.int(1, 3); i += 1) {
          if (!b.rng.chance(0.3)) b.flag(t + b.rng.range(1, dur), 'phone_detected');
        }
        b.snapshot(t + 2, 'phone_detected');
        b.burst(t + dur + 1, 20, 8);
      }
    },
  },
  {
    id: 'cheat-phone-down-gaze-iphone-lost',
    cohort: 'cheat',
    description:
      'Picks up the paired iPhone twice: it drops off the network, the student looks down 9-15 s, types afterwards.',
    expected: ['phone_use'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      for (const t of [520, 940].map((x) => x + b.rng.range(-40, 40))) {
        b.flag(t, 'iphone_lost');
        const dur = b.rng.range(9, 15);
        b.glance(t + 3, dur, 'down', b.rng.gauss(0, 4), -38);
        if (b.rng.chance(0.5)) b.flag(t + 5, 'phone_detected');
        if (b.rng.chance(0.5)) b.flag(t + 2, 'phone_left_app');
        b.flag(t + dur + 8, 'iphone_reconnected');
        b.burst(t + dur + 4, 30, 9);
      }
    },
  },
  {
    id: 'cheat-second-person-talking',
    cohort: 'cheat',
    description:
      'A helper leans in twice and talks through the answers; some faces and lines are missed by the trackers.',
    expected: ['second_person'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      helperVisit(b, b.rng.range(400, 600), HELPER_LINES.slice(0, 2));
      helperVisit(b, b.rng.range(850, 1050), HELPER_LINES.slice(2));
    },
  },
  {
    id: 'cheat-pasted-answers',
    cohort: 'cheat',
    description:
      'Answers pasted in from elsewhere three times; the mouse is still for two of them.',
    expected: ['external_answer_entry'],
    build: (b) => {
      b.typist(TYPISTS.sparse);
      b.inject(b.rng.range(320, 380), 120, true);
      b.inject(b.rng.range(620, 680), 210, false);
      b.inject(b.rng.range(980, 1060), 160, true);
    },
  },
  {
    id: 'cheat-burst-after-long-idle',
    cohort: 'cheat',
    description:
      'Hands off the laptop for 3-4 minutes (reading an answer elsewhere), then a long answer typed fast, twice.',
    expected: ['external_answer_entry'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      const first = b.rng.range(200, 260);
      b.idle(first, first + 220).burst(first + 222, 180, 35);
      const second = b.rng.range(800, 880);
      b.idle(second, second + 190).burst(second + 192, 150, 30);
    },
  },
  {
    id: 'cheat-second-screen',
    cohort: 'cheat',
    description:
      'A second monitor to the right with the answers: long reading glances, then typing; two displays reported.',
    expected: ['notes_or_second_screen'],
    build: (b) => {
      b.typist(TYPISTS.steady).glances({
        fromS: 250,
        count: 16,
        gapS: 60,
        direction: 'right',
        yaw: 42,
        pitch: -3,
        durS: [2, 6],
        missRate: 0.15,
        typeAfter: { p: 0.6, keys: 45, spanS: 9 },
      });
      for (let t = 30; t < b.durationS; t += 300) b.displays(t, 2);
    },
  },
  {
    id: 'cheat-leaving-exam-window',
    cohort: 'cheat',
    description: 'Switches to a browser six times; two presence pulses fail while away.',
    expected: ['left_exam'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      let t = b.rng.range(150, 250);
      for (let i = 0; i < 6; i += 1) {
        b.flag(t, 'focus_lost').flag(t + 0.4, 'page_hidden');
        if (b.rng.chance(0.5)) b.foregroundApp(t + 1.2, 'Google Chrome');
        if (i === 1 || i === 4) b.flag(t + 6, 'presence_check_failed');
        t += b.rng.range(120, 220);
      }
    },
  },
  {
    id: 'cheat-virtual-camera',
    cohort: 'cheat',
    description: 'Streams a recording through a virtual camera; the real camera is never verified.',
    expected: ['environment_risk'],
    build: (b) => {
      b.typist(TYPISTS.steady);
      b.flag(25, 'virtual_camera_connected').flag(31, 'camera_swapped_to_virtual');
      b.flag(62, 'camera_unverified');
      if (b.rng.chance(0.5)) b.flag(b.rng.range(600, 900), 'camera_feed_paused_virtual_camera');
    },
  },

  // ── Hard borderline cases ───────────────────────────────────────────────────
  {
    id: 'hard-cheat-sparse-notes',
    cohort: 'hard_cheat',
    description:
      'Notes used only for a few questions: nine glances, the tracker misses 40 %, half followed by typing.',
    expected: ['notes_or_second_screen'],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 500,
        count: 9,
        gapS: 70,
        direction: 'left',
        yaw: -30,
        pitch: 8,
        durS: [2, 4],
        missRate: 0.4,
        typeAfter: { p: 0.5, keys: 50, spanS: 9 },
      }),
  },
  {
    id: 'hard-cheat-phone-under-desk',
    cohort: 'hard_cheat',
    description:
      'A second phone kept under the desk, never in view: seven short (2.5-4.5 s) looks down, iPhone stays paired.',
    expected: ['phone_use'],
    build: (b) =>
      b.typist(TYPISTS.steady).glances({
        fromS: 300,
        count: 7,
        gapS: 130,
        direction: 'down',
        yaw: 4,
        pitch: -40,
        durS: [2.5, 4.5],
        typeAfter: { p: 0.6, keys: 14, spanS: 6 },
      }),
  },
  {
    id: 'hard-honest-calculator-spurious-phone',
    cohort: 'hard_honest',
    description:
      'Calculator user; the phone detector fires once on the calculator and the Wi-Fi drops the paired iPhone once.',
    expected: [],
    build: (b) => {
      b.typist(TYPISTS.steady).glances({
        fromS: 240,
        count: 8,
        gapS: 110,
        direction: 'down',
        yaw: 5,
        pitch: -28,
        durS: [3, 9],
        typeAfter: { p: 0.8, keys: 6, spanS: 3 },
      });
      b.flag(b.rng.range(480, 560), 'phone_detected');
      const drop = b.rng.range(700, 760);
      b.flag(drop, 'iphone_lost').flag(drop + 20, 'iphone_reconnected');
    },
  },
  {
    id: 'hard-honest-reads-aloud',
    cohort: 'hard_honest',
    description: 'Reads each question aloud to themself; face in view, speech transcribed.',
    expected: [],
    build: (b) => {
      b.typist(TYPISTS.steady);
      let t = b.rng.range(60, 120);
      for (const line of READ_ALOUD_LINES) {
        b.voice(t, b.rng.range(2.2, 4), -30);
        if (!b.rng.chance(0.25)) b.transcript(t, line);
        t += b.rng.range(200, 320);
      }
    },
  },
];

export function generateEvalSessions(seed = EVAL_SEED): EvalSession[] {
  return SCENARIOS.map((scenario) => {
    const rng = new Rng((seed ^ hashString(scenario.id)) >>> 0);
    const builder = new AttemptBuilder(rng, rng.int(1200, 1500));
    scenario.build(builder);
    builder.noise();
    return {
      id: scenario.id,
      cohort: scenario.cohort,
      description: scenario.description,
      expected: scenario.expected,
      rows: builder.build(scenario.id),
    };
  });
}

/** JSON with one row per line: readable diffs without the size of fully pretty JSON. */
export function formatSession(session: EvalSession): string {
  const { rows, ...label } = session;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(label)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "rows": {');
  const entries = Object.entries(rows);
  entries.forEach(([key, value], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`    ${JSON.stringify(key)}: []${comma}`);
      } else {
        lines.push(`    ${JSON.stringify(key)}: [`);
        value.forEach((row, i) => {
          lines.push(`      ${JSON.stringify(row)}${i < value.length - 1 ? ',' : ''}`);
        });
        lines.push(`    ]${comma}`);
      }
    } else {
      lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('  }');
  return `{\n${lines.join('\n')}\n}\n`;
}
