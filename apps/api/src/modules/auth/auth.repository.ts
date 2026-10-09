import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type {
  AuditEventInput,
  AuditSink,
  Opaque,
  UserId,
  UserRole,
} from '@exam-anti-cheat/contracts';

import type { SessionId } from './session.js';

export interface UserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface NewUserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

export interface NewSessionRecord {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

function isUserRole(value: unknown): value is UserRole {
  return value === 'student' || value === 'instructor';
}

function asOpaqueId<Brand extends string>(value: string): Opaque<string, Brand> {
  return value as Opaque<string, Brand>;
}

function readUser(row: Record<string, unknown>): UserRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.email !== 'string' ||
    typeof row.password_hash !== 'string' ||
    !isUserRole(row.role) ||
    typeof row.created_at !== 'string'
  ) {
    throw new Error('The database returned an invalid user record.');
  }

  return {
    id: asOpaqueId<'UserId'>(row.id),
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

function readSession(row: Record<string, unknown>): SessionRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.token_hash !== 'string' ||
    typeof row.csrf_token_hash !== 'string' ||
    typeof row.created_at !== 'string' ||
    typeof row.expires_at !== 'string' ||
    (row.revoked_at !== null && typeof row.revoked_at !== 'string')
  ) {
    throw new Error('The database returned an invalid session record.');
  }

  return {
    id: asOpaqueId<'SessionId'>(row.id),
    userId: asOpaqueId<'UserId'>(row.user_id),
    tokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class SqliteAuthRepository {
  constructor(private readonly database: DatabaseSync) {}

  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const value = await work();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }

  findUserByEmail(email: string): UserRecord | null {
    const row = this.database
      .prepare(
        `SELECT id, email, password_hash, role, created_at
         FROM users
         WHERE email = ?`,
      )
      .get(email);

    return row === undefined ? null : readUser(row);
  }

  findUserById(id: UserId): UserRecord | null {
    const row = this.database
      .prepare(
        `SELECT id, email, password_hash, role, created_at
         FROM users
         WHERE id = ?`,
      )
      .get(id);

    return row === undefined ? null : readUser(row);
  }

  insertUser(user: NewUserRecord): void {
    this.database
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(user.id, user.email, user.passwordHash, user.role, user.createdAt);
  }

  insertSession(session: NewSessionRecord): void {
    this.database
      .prepare(
        `INSERT INTO sessions
          (id, user_id, token_hash, csrf_token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.userId,
        session.tokenHash,
        session.csrfTokenHash,
        session.createdAt,
        session.expiresAt,
      );
  }

  findSessionByTokenHash(tokenHash: string): SessionRecord | null {
    const row = this.database
      .prepare(
        `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at, revoked_at
         FROM sessions
         WHERE token_hash = ?`,
      )
      .get(tokenHash);

    return row === undefined ? null : readSession(row);
  }

  updateSessionCsrfToken(sessionId: SessionId, csrfTokenHash: string, now: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET csrf_token_hash = ?
         WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(csrfTokenHash, sessionId, now);

    return Number(result.changes) > 0;
  }

  revokeSession(id: SessionId, revokedAt: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, id);

    return Number(result.changes) > 0;
  }
}

export class SqliteAuditSink implements AuditSink {
  constructor(private readonly database: DatabaseSync) {}

  append(event: AuditEventInput): void {
    if (event.attemptId !== undefined || event.metadata !== undefined) {
      throw new Error('This audit sink accepts only identity audit fields.');
    }

    this.database
      .prepare(
        `INSERT INTO audit_events (id, actor_user_id, action, occurred_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), event.actorId ?? null, event.action, event.occurredAt.toISOString());
  }
}
