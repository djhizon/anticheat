import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock, Opaque, UserId } from '@examguard/contracts';

import type { NewSessionRecord, SessionRecord, SqliteAuthRepository } from './auth.repository.js';

export type SessionId = Opaque<string, 'SessionId'>;
export type SessionToken = Opaque<string, 'SessionToken'>;
export type CsrfToken = Opaque<string, 'CsrfToken'>;

export const SESSION_TOKEN_BYTES = 32;
export const CSRF_TOKEN_BYTES = 32;

export interface TokenGenerator {
  generate(byteLength: number): string;
}

export class SecureTokenGenerator implements TokenGenerator {
  generate(byteLength: number): string {
    return randomBytes(byteLength).toString('base64url');
  }
}

export interface IssuedSession {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly token: SessionToken;
  readonly csrfToken: CsrfToken;
  readonly expiresAt: string;
}

export interface AuthenticatedSession {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly csrfTokenHash: string;
  readonly expiresAt: string;
}

export function asAuthOpaqueId<Kind extends string>(value: string): Opaque<string, Kind> {
  if (value.trim() === '') {
    throw new Error('Opaque authentication IDs must not be empty.');
  }

  return value as Opaque<string, Kind>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatchesHash(token: string | undefined, expectedHash: string): boolean {
  if (token === undefined) {
    return false;
  }

  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SessionService {
  constructor(
    private readonly repository: SqliteAuthRepository,
    private readonly clock: Clock,
    private readonly sessionTtlSeconds: number,
    private readonly tokenGenerator: TokenGenerator = new SecureTokenGenerator(),
  ) {
    if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
      throw new Error('Session TTL must be a positive integer.');
    }
  }

  create(userId: UserId): IssuedSession {
    const createdAt = this.clock.now();
    const expiresAt = new Date(createdAt.getTime() + this.sessionTtlSeconds * 1000);
    const sessionId = asAuthOpaqueId<'SessionId'>(
      this.tokenGenerator.generate(SESSION_TOKEN_BYTES),
    );
    const token = asAuthOpaqueId<'SessionToken'>(this.tokenGenerator.generate(SESSION_TOKEN_BYTES));
    const csrfToken = asAuthOpaqueId<'CsrfToken'>(this.tokenGenerator.generate(CSRF_TOKEN_BYTES));

    const record: NewSessionRecord = {
      id: sessionId,
      userId,
      tokenHash: hashToken(token),
      csrfTokenHash: hashToken(csrfToken),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.repository.insertSession(record);

    return {
      sessionId,
      userId,
      token,
      csrfToken,
      expiresAt: record.expiresAt,
    };
  }

  authenticate(token: string | undefined): AuthenticatedSession | null {
    if (token === undefined || token === '') {
      return null;
    }

    const record = this.repository.findSessionByTokenHash(hashToken(token));
    if (record === null || record.revokedAt !== null) {
      return null;
    }

    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock.now().getTime()) {
      return null;
    }

    return this.toAuthenticatedSession(record);
  }

  revoke(token: string | undefined): boolean {
    const session = this.authenticate(token);
    return session === null ? false : this.revokeSession(session.sessionId);
  }

  revokeSession(sessionId: SessionId, revokedAt = this.clock.now().toISOString()): boolean {
    return this.repository.revokeSession(sessionId, revokedAt);
  }

  private toAuthenticatedSession(record: SessionRecord): AuthenticatedSession {
    return {
      sessionId: record.id,
      userId: record.userId,
      csrfTokenHash: record.csrfTokenHash,
      expiresAt: record.expiresAt,
    };
  }
}
