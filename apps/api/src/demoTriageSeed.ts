/* global console */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { Clock } from '@examguard/contracts';
import type { AssignmentId, ExamVersionId } from '@examguard/contracts/exam';

import type { ApiConfig } from './config.js';
import type { AuthPlugin } from './modules/auth/auth.plugin.js';
import { createExamPlugin } from './modules/exam/exam.plugin.js';

/**
 * Extra demo students with synthetic, already-submitted attempts whose stored timelines give
 * the instructor triage screen one of each level: review, glance and none. Rows are inserted
 * directly (no browser involved); the demo student's own flow is untouched.
 */
export const triageStudents = [
  { email: 'triage.review@example.test', profile: 'review' },
  { email: 'triage.phone@example.test', profile: 'review' },
  { email: 'triage.glance@example.test', profile: 'glance' },
  { email: 'triage.clean@example.test', profile: 'none' },
] as const;

type Profile = (typeof triageStudents)[number]['profile'];

/** A clock the seed moves by hand so the synthetic attempt has a real 40-minute span. */
class ShiftedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(next: Date): void {
    this.current = next;
  }
}

// ── Tiny synthetic "photo": a valid baseline JPEG, 32×32, grey with a soft gradient ─────────
// There is no image encoder in the API, so the seed writes a minimal DC-only JPEG by hand.
// Enough for the evidence gallery to show a real image instead of a broken thumbnail.

function huffmanTable(classId: number, counts: readonly number[], symbols: readonly number[]) {
  return [0xff, 0xc4, 0x00, 3 + 16 + symbols.length, classId, ...counts, ...symbols];
}

class BitWriter {
  readonly bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.n += 1;
      if (this.n === 8) this.flush();
    }
  }
  private flush(): void {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00);
    this.acc = 0;
    this.n = 0;
  }
  finish(): number[] {
    while (this.n !== 0) this.write(1, 1);
    return this.bytes;
  }
}

/** `shade` 0..255 base grey; the gradient makes each "photo" look slightly different. */
export function syntheticJpeg(shade: number, seed = 0): Buffer {
  const blocks = 4; // 32×32 pixels = 4×4 blocks of 8×8
  const quant = 16; // DC quantiser: coefficient = 8 × (mean − 128) / 16
  const header = [
    0xff,
    0xd8, // SOI
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...Array.from({ length: 64 }, () => quant), // DQT
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    blocks * 8,
    0x00,
    blocks * 8,
    0x01,
    0x01,
    0x11,
    0x00, // SOF0
    // DC table: seven 3-bit codes for categories 0..6 (the all-ones code must stay unused, or
    // libjpeg rejects the table); AC table: one 1-bit code for EOB.
    ...huffmanTable(0x00, [0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6]),
    ...huffmanTable(0x10, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0x00]),
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00, // SOS
  ];
  const bits = new BitWriter();
  let previous = 0;
  for (let index = 0; index < blocks * blocks; index += 1) {
    const row = Math.floor(index / blocks);
    const column = index % blocks;
    const mean = Math.max(
      16,
      Math.min(240, shade + row * 6 - column * 4 + ((seed + index) % 3) * 3),
    );
    const coefficient = Math.round((8 * (mean - 128)) / quant);
    let diff = coefficient - previous;
    previous = coefficient;
    diff = Math.max(-63, Math.min(63, diff));
    const magnitude = Math.abs(diff);
    const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
    bits.write(category, 3);
    if (category > 0) bits.write(diff > 0 ? diff : diff - 1 + (1 << category), category);
    bits.write(0, 1); // EOB
  }
  return Buffer.from([...header, ...bits.finish(), 0xff, 0xd9]);
}

interface Inserter {
  readonly db: DatabaseSync;
  readonly attemptId: string;
  readonly startedAt: Date;
}

const at = (ctx: Inserter, minutes: number, seconds = 0): string =>
  new Date(ctx.startedAt.getTime() + minutes * 60_000 + seconds * 1000).toISOString();

function gaze(
  ctx: Inserter,
  minutes: number,
  seconds: number,
  durationMs: number,
  direction: string,
  yaw: number | null = null,
  pitch: number | null = null,
) {
  ctx.db
    .prepare(
      `INSERT INTO gaze_events (id, attempt_id, off_screen_start, duration_ms, direction, yaw, pitch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      ctx.attemptId,
      at(ctx, minutes, seconds),
      durationMs,
      direction,
      yaw,
      pitch,
      at(ctx, minutes, seconds),
    );
}

function flag(ctx: Inserter, minutes: number, seconds: number, name: string) {
  ctx.db
    .prepare(
      `INSERT INTO app_events (id, attempt_id, foreground_app, display_count, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(randomUUID(), ctx.attemptId, `flag:${name}`, at(ctx, minutes, seconds));
}

function voice(ctx: Inserter, minutes: number, seconds: number, durationMs: number) {
  ctx.db
    .prepare(
      `INSERT INTO voice_events (id, attempt_id, detected_at, duration_ms, peak_db, created_at)
       VALUES (?, ?, ?, ?, -18, ?)`,
    )
    .run(
      randomUUID(),
      ctx.attemptId,
      at(ctx, minutes, seconds),
      durationMs,
      at(ctx, minutes, seconds),
    );
}

function transcript(ctx: Inserter, minutes: number, seconds: number, text: string) {
  ctx.db
    .prepare(
      `INSERT INTO audio_transcripts (id, attempt_id, captured_at, text) VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), ctx.attemptId, at(ctx, minutes, seconds), text);
}

function photo(ctx: Inserter, minutes: number, seconds: number, trigger: string, shade: number) {
  const captured = at(ctx, minutes, seconds);
  ctx.db
    .prepare(
      `INSERT INTO evidence_snapshots (id, attempt_id, source, trigger, captured_at, created_at, mime, bytes)
       VALUES (?, ?, 'webcam', ?, ?, ?, 'image/jpeg', ?)`,
    )
    .run(
      randomUUID(),
      ctx.attemptId,
      trigger,
      captured,
      captured,
      new Uint8Array(syntheticJpeg(shade, minutes)),
    );
}

function revision(
  ctx: Inserter,
  minutes: number,
  seconds: number,
  question: string,
  words: number,
) {
  ctx.db
    .prepare(
      `INSERT INTO answer_revisions (id, attempt_id, question_version_id, value_text, word_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      ctx.attemptId,
      question,
      'x '.repeat(words).trim(),
      words,
      at(ctx, minutes, seconds),
    );
}

/**
 * Stored events for each profile, relative to the attempt start. Tuned to the findings engine's
 * FINDING_THRESHOLDS (apps/api/src/modules/integrity/findings.ts): the first 3 minutes are the
 * student's baseline, so the synthetic patterns begin after that.
 */
function insertTimeline(ctx: Inserter, profile: Profile, variant: number, question: string): void {
  if (profile === 'none') {
    // Two short glances in different directions and ordinary typing: no finding.
    gaze(ctx, 4, 10, 1800, 'left', -14, 2);
    gaze(ctx, 17, 42, 2100, 'down', 3, -18);
    revision(ctx, 6, 0, question, 12);
    revision(ctx, 9, 30, question, 26);
    return;
  }
  if (profile === 'glance') {
    // Two separate focus losses (low-confidence "left the exam") and nothing else: glance.
    gaze(ctx, 3, 5, 6500, 'away', 20, 4);
    gaze(ctx, 12, 20, 7200, 'right', 24, 1);
    flag(ctx, 12, 28, 'focus_lost');
    flag(ctx, 23, 4, 'focus_lost');
    voice(ctx, 21, 2, 2400);
    photo(ctx, 12, 24, 'look_away', 150);
    revision(ctx, 5, 0, question, 15);
    revision(ctx, 14, 0, question, 30);
    return;
  }
  if (variant === 0) {
    // Eight glances to one spot (yaw/pitch within ±8°), six followed by an answer growing by
    // 25+ words within 10 s; a second person with speech; one phone sighting next to a glance.
    for (let i = 0; i < 8; i += 1) {
      const durationMs = 7000 + i * 400;
      gaze(ctx, 6 + i * 2, 10 + i * 5, durationMs, 'down', 2 + (i % 3), -24 + (i % 2));
      if (i !== 2 && i !== 5) {
        revision(ctx, 6 + i * 2, 10 + i * 5 + durationMs / 1000 + 4, question, 30 + i * 25);
      }
    }
    photo(ctx, 8, 17, 'look_away', 120);
    photo(ctx, 14, 38, 'look_away', 135);
    flag(ctx, 15, 2, 'phone_detected');
    photo(ctx, 15, 2, 'phone_detected', 90);
    voice(ctx, 22, 10, 6100);
    transcript(ctx, 22, 11, 'what did you put for number four');
    transcript(ctx, 22, 18, 'I think it is the network layer');
    gaze(ctx, 22, 30, 14_000, 'multiple_faces');
    photo(ctx, 22, 33, 'multiple_faces', 170);
    return;
  }
  // Phone use (two sightings three minutes apart, a long look down while the iPhone dropped
  // off) and a second person in view twice, with speech.
  gaze(ctx, 9, 0, 21_000, 'multiple_faces');
  photo(ctx, 9, 3, 'multiple_faces', 160);
  gaze(ctx, 9, 40, 18_000, 'multiple_faces');
  voice(ctx, 9, 45, 4800);
  transcript(ctx, 9, 46, 'read me the options again');
  flag(ctx, 18, 12, 'phone_detected');
  photo(ctx, 18, 12, 'phone_detected', 95);
  flag(ctx, 18, 30, 'iphone_lost');
  gaze(ctx, 18, 45, 11_000, 'down', 1, -30);
  photo(ctx, 18, 50, 'phone_detected', 100);
  flag(ctx, 21, 40, 'phone_detected');
  flag(ctx, 27, 0, 'page_hidden');
  gaze(ctx, 27, 2, 16_000, 'no_face');
  revision(ctx, 20, 0, question, 20);
  revision(ctx, 28, 0, question, 55);
}

export interface TriageSeedContext {
  readonly auth: AuthPlugin;
  readonly config: ApiConfig;
  readonly examVersionId: ExamVersionId;
  readonly password: string;
  readonly ensureAccount: (email: string, password: string) => Promise<void>;
}

export async function seedTriageStudents(context: TriageSeedContext): Promise<void> {
  const { auth, config, examVersionId } = context;
  const clock = new ShiftedClock(new Date());
  const exam = createExamPlugin(auth.database, auth.boundary, config, { clock });

  for (const [index, entry] of triageStudents.entries()) {
    await context.ensureAccount(entry.email, context.password);
    const student = auth.repository.findUserByEmail(entry.email);
    if (student === null || student.role !== 'student') {
      throw new Error('A demo triage account could not be prepared.');
    }
    const existing = auth.database
      .prepare(
        `SELECT a.id AS id, t.id AS attempt_id, t.status AS status, t.started_at AS started_at
           FROM exam_assignments a LEFT JOIN exam_attempts t ON t.assignment_id = a.id
          WHERE a.exam_version_id = ? AND a.student_id = ?`,
      )
      .get(examVersionId, student.id) as
      | { id: string; attempt_id: string | null; status: string | null; started_at: string | null }
      | undefined;

    let attemptId: string;
    let startedAt: Date;
    if (existing?.status === 'submitted' && existing.attempt_id !== null) {
      attemptId = existing.attempt_id;
      startedAt = new Date(existing.started_at ?? Date.now());
    } else {
      // Start 40 minutes ago, submit 5 minutes ago, so the events sit inside the attempt.
      startedAt = new Date(Date.now() - 40 * 60_000);
      clock.set(startedAt);
      const assignmentId =
        existing === undefined
          ? await exam.service.assignExam({ examVersionId, studentId: student.id })
          : (existing.id as AssignmentId);
      const { delivery } = await exam.service.startAttempt(assignmentId, student.id);
      attemptId = String(delivery.attempt.id);
      clock.set(new Date(Date.now() - 5 * 60_000));
      await exam.service.submitAttemptWithAnswers(delivery.attempt.id, student.id, {
        expectedRevision: delivery.answers.revision,
        idempotencyKey: `seed-submit-${attemptId}-1`,
      });
    }

    const alreadySeeded = auth.database
      .prepare(`SELECT 1 AS present FROM gaze_events WHERE attempt_id = ? LIMIT 1`)
      .get(attemptId);
    if (alreadySeeded !== undefined) continue;
    const question = auth.database
      .prepare(
        `SELECT question_version_id FROM exam_version_questions WHERE exam_version_id = ? ORDER BY position LIMIT 1`,
      )
      .get(examVersionId) as { question_version_id: string } | undefined;
    insertTimeline(
      { db: auth.database, attemptId, startedAt },
      entry.profile,
      index,
      question?.question_version_id ?? 'q1',
    );
  }
  console.log(`✅  Triage demo:   ${triageStudents.map((s) => s.email).join(', ')}`);
}
