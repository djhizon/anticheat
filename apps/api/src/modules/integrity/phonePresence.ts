import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError, type Clock } from '@exam-anti-cheat/contracts';

export const PHONE_PING_MS = 2000;
export const PHONE_LEASE_MS = 8000;
const PAIRING_MS = 120000;
const CHALLENGE_MS = 4000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function secret(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new DomainError('unauthorized', 'Phone pairing is invalid or expired.');
  }
  return value;
}
interface Row {
  attempt_id: string;
  pairing_hash: string | null;
  pairing_expires_ms: number;
  credential_hash: string | null;
  credential_expires_ms: number;
  sequence: number;
}
export interface PhonePresenceStatus {
  required: boolean;
  active: boolean;
  remainingMs: number;
  heartbeatIntervalMs: number;
  timeoutMs: number;
}

/** Cooperative presence, not iOS attestation. No heartbeat history is retained.
 * Leases/challenges are deliberately memory-only: restart must fail closed.
 */
export class PhonePresenceService {
  private readonly leases = new Map<string, number>();
  private readonly challenges = new Map<string, { value: string; issued: number }>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  enroll(attemptId: string) {
    const deadline = this.activeDeadline(attemptId);
    const now = this.now();
    const code = token();
    this.db
      .prepare(
        `INSERT INTO phone_presence
      (attempt_id, pairing_hash, pairing_expires_ms, credential_expires_ms)
      VALUES (?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET
      pairing_hash=excluded.pairing_hash, pairing_expires_ms=excluded.pairing_expires_ms,
      credential_hash=NULL, credential_expires_ms=excluded.credential_expires_ms, sequence=0`,
      )
      .run(attemptId, hash(code), Math.min(now + PAIRING_MS, deadline), deadline);
    this.leases.delete(attemptId);
    this.challenges.delete(attemptId);
    return {
      code,
      expiresAt: new Date(Math.min(now + PAIRING_MS, deadline)).toISOString(),
      heartbeatIntervalMs: PHONE_PING_MS,
      timeoutMs: PHONE_LEASE_MS,
    };
  }

  claim(value: unknown) {
    const pairingHash = hash(secret(value));
    const row = this.db
      .prepare('SELECT * FROM phone_presence WHERE pairing_hash=?')
      .get(pairingHash) as unknown as Row | undefined;
    if (!row || this.now() >= row.pairing_expires_ms) this.reject();
    this.activeDeadline(row.attempt_id);
    const credential = token();
    // Synchronous compare-and-swap consumes the QR exactly once.
    const result = this.db
      .prepare(
        `UPDATE phone_presence SET pairing_hash=NULL, credential_hash=?, sequence=0
      WHERE attempt_id=? AND pairing_hash=?`,
      )
      .run(hash(credential), row.attempt_id, pairingHash);
    if (result.changes !== 1) this.reject();
    return { credential, heartbeatIntervalMs: PHONE_PING_MS, timeoutMs: PHONE_LEASE_MS };
  }

  challenge(value: unknown) {
    const row = this.authenticate(value);
    const issued = this.now();
    const previous = this.challenges.get(row.attempt_id);
    // One outstanding challenge, bounded storage. Frequent retries don't renew it.
    const challenge =
      previous && issued - previous.issued >= 0 && issued - previous.issued < CHALLENGE_MS
        ? previous
        : { value: token(), issued };
    this.challenges.set(row.attempt_id, challenge);
    return { challenge: challenge.value, sequence: row.sequence + 1 };
  }

  heartbeat(value: unknown, challengeValue: unknown, sequence: unknown, active: unknown) {
    const row = this.authenticate(value);
    const challenge = this.challenges.get(row.attempt_id);
    const now = this.now();
    if (
      active !== true ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) <= row.sequence ||
      !challenge ||
      challenge.value !== challengeValue ||
      now < challenge.issued ||
      now - challenge.issued >= CHALLENGE_MS
    ) {
      throw new DomainError('conflict', 'Phone heartbeat is stale. Request a fresh challenge.');
    }
    this.challenges.delete(row.attempt_id);
    this.db
      .prepare('UPDATE phone_presence SET sequence=? WHERE attempt_id=?')
      .run(sequence as number, row.attempt_id);
    // A delayed request cannot extend presence by a full timeout from receipt.
    this.leases.set(row.attempt_id, challenge.issued + PHONE_LEASE_MS);
    return { ok: true, remainingMs: challenge.issued + PHONE_LEASE_MS - now };
  }

  status(attemptId: string): PhonePresenceStatus {
    const row = this.db
      .prepare('SELECT attempt_id FROM phone_presence WHERE attempt_id=?')
      .get(attemptId);
    let remainingMs = 0;
    if (row) {
      try {
        const deadline = this.activeDeadline(attemptId);
        remainingMs = Math.max(0, Math.min(this.leases.get(attemptId) ?? 0, deadline) - this.now());
        if (remainingMs > PHONE_LEASE_MS) remainingMs = 0; // clock moved backwards
      } catch {
        this.leases.delete(attemptId);
        this.challenges.delete(attemptId);
      }
    }
    return {
      required: !!row,
      active: remainingMs > 0,
      remainingMs,
      heartbeatIntervalMs: PHONE_PING_MS,
      timeoutMs: PHONE_LEASE_MS,
    };
  }

  assertCanAnswer(attemptId: string) {
    const status = this.status(attemptId);
    if (status.required && !status.active) {
      throw new DomainError(
        'conflict',
        'Phone connection lost. Open the paired iPhone app to resume answering.',
      );
    }
  }

  private authenticate(value: unknown): Row {
    const row = this.db
      .prepare('SELECT * FROM phone_presence WHERE credential_hash=?')
      .get(hash(secret(value))) as unknown as Row | undefined;
    if (!row || this.now() >= row.credential_expires_ms) this.reject();
    this.activeDeadline(row.attempt_id);
    return row;
  }
  private activeDeadline(attemptId: string): number {
    const row = this.db
      .prepare('SELECT status, effective_deadline FROM exam_attempts WHERE id=?')
      .get(attemptId);
    const deadline = Date.parse(String(row?.effective_deadline));
    if (
      !row ||
      row.status !== 'in_progress' ||
      !Number.isFinite(deadline) ||
      this.now() >= deadline
    )
      this.reject();
    return deadline;
  }
  private reject(): never {
    throw new DomainError('unauthorized', 'Phone pairing is invalid or the exam has ended.');
  }
  private now() {
    return this.clock.now().getTime();
  }
}
