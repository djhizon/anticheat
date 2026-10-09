import type { DatabaseSync } from 'node:sqlite';

import type {
  ReviewDecision,
  ReviewDecisionValue,
  ReviewDecisionRequest,
} from '@examguard/contracts/findings';
import { FINDING_NOTE_MAX } from '@examguard/contracts/findings';
import { DomainError } from '@examguard/contracts';

/** Instructor decision notes are short free text; longer notes belong in the LMS. */
export const DECISION_NOTE_MAX = 500;

interface DecisionRow {
  readonly attempt_id: string;
  readonly decision: ReviewDecisionValue;
  readonly note: string | null;
  readonly decided_by: string;
  readonly decided_at: string;
}

function toDecision(row: DecisionRow): ReviewDecision {
  return {
    attemptId: row.attempt_id,
    decision: row.decision,
    note: row.note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

/**
 * Student notes on findings, keyed by finding id. Safe to call before migration 0014 ran
 * (returns an empty map), so the findings engine can read notes opportunistically.
 */
export function getFindingNotes(
  db: DatabaseSync,
  attemptId: string,
): ReadonlyMap<string, { readonly note: string; readonly createdAt: string }> {
  const notes = new Map<string, { note: string; createdAt: string }>();
  if (!tableExists(db, 'finding_notes')) return notes;
  const rows = db
    .prepare(
      `SELECT finding_id, note, created_at FROM finding_notes WHERE attempt_id = ? ORDER BY created_at`,
    )
    .all(attemptId) as unknown as ReadonlyArray<{
    finding_id: string;
    note: string;
    created_at: string;
  }>;
  for (const row of rows) notes.set(row.finding_id, { note: row.note, createdAt: row.created_at });
  return notes;
}

export function parseReviewDecisionRequest(body: unknown): ReviewDecisionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('validation_failed', 'A decision is required.');
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.decision !== 'fine' && candidate.decision !== 'follow_up') {
    throw new DomainError('validation_failed', 'decision must be "fine" or "follow_up".');
  }
  if (candidate.note !== undefined && typeof candidate.note !== 'string') {
    throw new DomainError('validation_failed', 'note must be text.');
  }
  const note = typeof candidate.note === 'string' ? candidate.note.trim() : '';
  if (note.length > DECISION_NOTE_MAX) {
    throw new DomainError(
      'validation_failed',
      `note must be at most ${DECISION_NOTE_MAX} characters.`,
    );
  }
  return note === '' ? { decision: candidate.decision } : { decision: candidate.decision, note };
}

export function parseFindingNote(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('validation_failed', 'A note is required.');
  }
  const note = (body as Record<string, unknown>).note;
  if (typeof note !== 'string') {
    throw new DomainError('validation_failed', 'note must be text.');
  }
  if (note.length > FINDING_NOTE_MAX) {
    throw new DomainError(
      'validation_failed',
      `note must be at most ${FINDING_NOTE_MAX} characters.`,
    );
  }
  return note;
}

/** Review decisions (instructor) and finding notes (student) for the triage screens. */
export class ReviewRepository {
  constructor(private readonly db: DatabaseSync) {}

  attemptExists(attemptId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 AS present FROM exam_attempts WHERE id = ?`).get(attemptId) !==
      undefined
    );
  }

  saveDecision(
    attemptId: string,
    request: ReviewDecisionRequest,
    decidedBy: string,
    decidedAt: string,
  ): ReviewDecision {
    this.db
      .prepare(
        `INSERT INTO review_decisions (attempt_id, decision, note, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (attempt_id) DO UPDATE SET
           decision = excluded.decision, note = excluded.note,
           decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
      )
      .run(attemptId, request.decision, request.note ?? null, decidedBy, decidedAt);
    return {
      attemptId,
      decision: request.decision,
      note: request.note ?? null,
      decidedBy,
      decidedAt,
    };
  }

  getDecision(attemptId: string): ReviewDecision | null {
    const row = this.db
      .prepare(
        `SELECT attempt_id, decision, note, decided_by, decided_at FROM review_decisions WHERE attempt_id = ?`,
      )
      .get(attemptId) as unknown as DecisionRow | undefined;
    return row === undefined ? null : toDecision(row);
  }

  /** Every decision, keyed by attempt id (one query for the instructor list). */
  listDecisions(): ReadonlyMap<string, ReviewDecision> {
    const rows = this.db
      .prepare(`SELECT attempt_id, decision, note, decided_by, decided_at FROM review_decisions`)
      .all() as unknown as readonly DecisionRow[];
    return new Map(rows.map((row) => [row.attempt_id, toDecision(row)]));
  }

  /** Empty note clears the student's earlier note. */
  saveFindingNote(attemptId: string, findingId: string, note: string, createdAt: string): void {
    if (note.trim() === '') {
      this.db
        .prepare(`DELETE FROM finding_notes WHERE attempt_id = ? AND finding_id = ?`)
        .run(attemptId, findingId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO finding_notes (attempt_id, finding_id, note, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (attempt_id, finding_id) DO UPDATE SET
           note = excluded.note, created_at = excluded.created_at`,
      )
      .run(attemptId, findingId, note, createdAt);
  }

  getFindingNotes(attemptId: string) {
    return getFindingNotes(this.db, attemptId);
  }
}
