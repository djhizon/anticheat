import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError, type Clock } from '@exam-anti-cheat/contracts';

export const PHONE_PING_MS = 2000;
export const PHONE_LEASE_MS = 8000;
const PAIRING_MS = 120000;
const CHALLENGE_MS = 4000;
/** Phone sends at most every 5 s; the server accepts one report per 2 s per attempt. */
export const DESK_CAMERA_MIN_GAP_MS = 2000;
/** A desk-camera report older than this means the camera is considered off. */
export const DESK_CAMERA_STALE_MS = 15000;
/** The same flag is stored at most once per window so a flickering view cannot spam the report. */
const DESK_FLAG_COOLDOWN_MS = 30000;
const MAX_PEOPLE = 20;
const MAX_HANDS = 8;
/** Object hints the phone may report (label names only). Anything else is rejected. */
export const DESK_OBJECT_HINTS = ['cellphone', 'paper', 'book', 'bright_rectangle'] as const;
/** Desk state and flag cooldowns for an attempt with no report this long are dropped. */
const DESK_STATE_IDLE_MS = 10 * 60000;
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
  deskCamera: DeskCameraState;
}
export interface DeskCameraState {
  on: boolean;
  framingOk: boolean;
  people: number;
  handsVisible: boolean;
  extraPerson: boolean;
  extraHands: boolean;
  handCount: number;
  leftHands: number;
  rightHands: number;
  textVisible: boolean;
  objectHints: string[];
  cameraObstructed: boolean;
}
/** Optional, additive flags from newer phones. Old phones omit all of them. */
export interface DeskCameraExtras {
  extraPerson?: unknown;
  extraHands?: unknown;
  handCount?: unknown;
  leftHands?: unknown;
  rightHands?: unknown;
  textVisible?: unknown;
  objectHints?: unknown;
  cameraObstructed?: unknown;
}
interface DeskReport {
  people: number;
  handsVisible: boolean;
  framingOk: boolean;
  extraPerson: boolean;
  extraHands: boolean;
  handCount: number;
  leftHands: number;
  rightHands: number;
  textVisible: boolean;
  objectHints: string[];
  cameraObstructed: boolean;
  at: number;
}
function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean')
    throw new DomainError('validation_failed', 'Desk camera status is invalid.');
  return value;
}
function optionalCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_HANDS) {
    throw new DomainError('validation_failed', 'Desk camera status is invalid.');
  }
  return value;
}
function optionalHints(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > DESK_OBJECT_HINTS.length ||
    value.some((h) => !(DESK_OBJECT_HINTS as readonly unknown[]).includes(h))
  ) {
    throw new DomainError('validation_failed', 'Desk camera status is invalid.');
  }
  return [...new Set(value as string[])].sort();
}

/** Cooperative presence, not iOS attestation. No heartbeat history is retained.
 * Leases/challenges are deliberately memory-only: restart must fail closed.
 */
export class PhonePresenceService {
  private readonly leases = new Map<string, number>();
  private readonly challenges = new Map<string, { value: string; issued: number }>();
  private readonly desk = new Map<string, DeskReport>();
  private readonly deskFlags = new Map<string, number>();
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
    this.clearDesk(attemptId);
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
    // Log the pairing in the unified integrity log (timestamp only, no credential).
    this.db
      .prepare(
        'INSERT INTO app_events (id, attempt_id, foreground_app, display_count) VALUES (?, ?, ?, 1)',
      )
      .run(randomUUID(), row.attempt_id, 'flag:iphone_paired');
    // attemptId lets the phone address evidence snapshots; it is the student's own attempt.
    return {
      credential,
      attemptId: row.attempt_id,
      heartbeatIntervalMs: PHONE_PING_MS,
      timeoutMs: PHONE_LEASE_MS,
    };
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

  /** Attempt a valid, unexpired phone credential is paired to; throws unauthorized otherwise. */
  attemptIdForCredential(value: unknown): string {
    return this.authenticate(value).attempt_id;
  }

  /** Optional desk-camera flags from the phone. Flags only; never images. Does not touch the lease.
   * These are cooperative signals authenticated only by the pairing credential: whoever holds
   * it can send or withhold them. They are leads for a human reviewer, not verdicts. */
  deskCamera(
    value: unknown,
    people: unknown,
    handsVisible: unknown,
    framingOk: unknown,
    extras: DeskCameraExtras = {},
  ) {
    const row = this.authenticate(value);
    if (
      typeof people !== 'number' ||
      !Number.isSafeInteger(people) ||
      people < 0 ||
      people > MAX_PEOPLE ||
      typeof handsVisible !== 'boolean' ||
      typeof framingOk !== 'boolean'
    ) {
      throw new DomainError('validation_failed', 'Desk camera status is invalid.');
    }
    const extraPersonSent = optionalBool(extras.extraPerson);
    const extraHands = optionalBool(extras.extraHands) ?? false;
    const textVisible = optionalBool(extras.textVisible) ?? false;
    const cameraObstructed = optionalBool(extras.cameraObstructed) ?? false;
    const handCount = optionalCount(extras.handCount);
    const leftHands = optionalCount(extras.leftHands);
    const rightHands = optionalCount(extras.rightHands);
    const objectHints = optionalHints(extras.objectHints);
    // Newer phones debounce the second-person decision on-device; older ones only send a count.
    const extraPerson = extraPersonSent ?? people >= 2;
    const now = this.now();
    this.pruneDesk(now);
    const previous = this.desk.get(row.attempt_id);
    if (previous && now >= previous.at && now - previous.at < DESK_CAMERA_MIN_GAP_MS) {
      throw new DomainError('conflict', 'Desk camera status sent too often.');
    }
    this.desk.set(row.attempt_id, {
      people,
      handsVisible,
      framingOk,
      extraPerson,
      extraHands,
      handCount,
      leftHands,
      rightHands,
      textVisible,
      objectHints,
      cameraObstructed,
      at: now,
    });
    const fresh = previous !== undefined && now - previous.at < DESK_CAMERA_STALE_MS;
    if (extraPerson && (!fresh || !previous.extraPerson)) {
      this.flag(row.attempt_id, 'desk_camera_extra_person', now);
    }
    if (extraHands && (!fresh || !previous.extraHands)) {
      this.flag(row.attempt_id, 'desk_camera_extra_hands', now);
    }
    if (textVisible && (!fresh || !previous.textVisible)) {
      this.flag(row.attempt_id, 'desk_camera_text_visible', now);
    }
    if (cameraObstructed && (!fresh || !previous.cameraObstructed)) {
      this.flag(row.attempt_id, 'desk_camera_obstructed', now);
    }
    for (const hint of objectHints) {
      if (!fresh || !previous.objectHints.includes(hint)) {
        this.flag(row.attempt_id, `desk_camera_object_${hint}`, now);
      }
    }
    if (people === 0 && fresh && previous.people >= 1) {
      this.flag(row.attempt_id, 'desk_camera_left_frame', now);
    }
    return { ok: true };
  }

  /** Bounded memory: drop idle or ended-attempt desk state and expired flag cooldowns. */
  private pruneDesk(now: number) {
    for (const [id, report] of this.desk) {
      if (now < report.at || now - report.at >= DESK_STATE_IDLE_MS) this.clearDesk(id);
    }
    for (const [key, last] of this.deskFlags) {
      if (now < last || now - last >= DESK_FLAG_COOLDOWN_MS) this.deskFlags.delete(key);
    }
  }
  private clearDesk(attemptId: string) {
    this.desk.delete(attemptId);
    const prefix = `${attemptId}:`;
    for (const key of this.deskFlags.keys()) if (key.startsWith(prefix)) this.deskFlags.delete(key);
  }
  /** In-memory state held for an attempt (for tests and diagnostics). */
  memorySize() {
    return this.desk.size + this.deskFlags.size;
  }

  private flag(attemptId: string, name: string, now: number) {
    const key = `${attemptId}:${name}`;
    const last = this.deskFlags.get(key);
    if (last !== undefined && now >= last && now - last < DESK_FLAG_COOLDOWN_MS) return;
    this.deskFlags.set(key, now);
    this.db
      .prepare(
        'INSERT INTO app_events (id, attempt_id, foreground_app, display_count) VALUES (?, ?, ?, 1)',
      )
      .run(randomUUID(), attemptId, `flag:${name}`);
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
        this.clearDesk(attemptId); // attempt ended
      }
    }
    const report = this.desk.get(attemptId);
    const age = report ? this.now() - report.at : Infinity;
    const on = !!report && age >= 0 && age < DESK_CAMERA_STALE_MS;
    return {
      deskCamera: {
        on,
        framingOk: on && report.framingOk,
        people: on ? report.people : 0,
        handsVisible: on && report.handsVisible,
        extraPerson: on && report.extraPerson,
        extraHands: on && report.extraHands,
        handCount: on ? report.handCount : 0,
        leftHands: on ? report.leftHands : 0,
        rightHands: on ? report.rightHands : 0,
        textVisible: on && report.textVisible,
        objectHints: on ? report.objectHints : [],
        cameraObstructed: on && report.cameraObstructed,
      },
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
