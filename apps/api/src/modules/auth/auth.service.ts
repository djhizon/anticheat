import {
  DomainError,
  type AuditSink,
  type Clock,
  type UserId,
  type UserRole,
} from '@exam-anti-cheat/contracts';

import { hashPassword, verifyPassword } from './password.js';
import {
  asAuthOpaqueId,
  hashToken,
  SecureTokenGenerator,
  type AuthenticatedSession,
  type CsrfToken,
  type IssuedSession,
  type SessionToken,
  type SessionService,
  type TokenGenerator,
} from './session.js';
import { SqliteAuthRepository, type UserRecord } from './auth.repository.js';

export interface CredentialsInput {
  readonly email: string;
  readonly password: string;
}

export interface AuthUserView {
  readonly id: UserId;
  readonly email: string;
  readonly role: UserRole;
}

export interface AuthSessionResult {
  readonly user: AuthUserView;
  readonly sessionToken: SessionToken;
  readonly csrfToken: CsrfToken;
  readonly expiresAt: string;
}

export interface AuthenticatedPrincipal {
  readonly user: AuthUserView;
  readonly session: AuthenticatedSession;
}

export interface AuthServiceDependencies {
  readonly repository: SqliteAuthRepository;
  readonly sessions: SessionService;
  readonly clock: Clock;
  readonly auditSink: AuditSink;
  readonly idGenerator?: TokenGenerator;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateCredentials(input: CredentialsInput): string {
  const email = normalizeEmail(input.email);
  if (!emailPattern.test(email) || email.length > 320) {
    throw new DomainError('validation_failed', 'Email address is invalid.');
  }

  if (input.password.length === 0 || input.password.length > 1024) {
    throw new DomainError('validation_failed', 'Password length is outside the supported range.');
  }

  return email;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export class AuthService {
  private readonly idGenerator: TokenGenerator;

  constructor(private readonly dependencies: AuthServiceDependencies) {
    this.idGenerator = dependencies.idGenerator ?? new SecureTokenGenerator();
  }

  async register(input: CredentialsInput): Promise<AuthSessionResult> {
    const email = validateCredentials(input);
    if (this.dependencies.repository.findUserByEmail(email) !== null) {
      throw new DomainError('conflict', 'An account already exists for this email address.');
    }

    const passwordHash = await hashPassword(input.password);
    const now = this.dependencies.clock.now();
    const user: UserRecord = {
      id: asAuthOpaqueId<'UserId'>(this.idGenerator.generate(32)),
      email,
      passwordHash,
      role: 'student',
      createdAt: now.toISOString(),
    };

    try {
      return await this.dependencies.repository.withTransaction(async () => {
        this.dependencies.repository.insertUser(user);
        const issued = this.dependencies.sessions.create(user.id);
        await this.recordAudit('auth.registered', user.id, now);
        return this.toSessionResult(user, issued);
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new DomainError('conflict', 'An account already exists for this email address.');
      }
      throw error;
    }
  }

  async login(input: CredentialsInput, previousSessionToken?: string): Promise<AuthSessionResult> {
    const email = validateCredentials(input);
    const user = this.dependencies.repository.findUserByEmail(email);
    if (user === null || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new DomainError('unauthorized', 'The supplied credentials are not valid.');
    }

    const previousSession = this.dependencies.sessions.authenticate(previousSessionToken);
    const now = this.dependencies.clock.now();

    return this.dependencies.repository.withTransaction(async () => {
      if (previousSession !== null) {
        this.dependencies.sessions.revokeSession(previousSession.sessionId, now.toISOString());
      }

      const issued = this.dependencies.sessions.create(user.id);
      await this.recordAudit('auth.logged_in', user.id, now);
      return this.toSessionResult(user, issued);
    });
  }

  authenticateSession(sessionToken: string | undefined): AuthenticatedPrincipal | null {
    const session = this.dependencies.sessions.authenticate(sessionToken);
    if (session === null) {
      return null;
    }

    const user = this.dependencies.repository.findUserById(session.userId);
    return user === null ? null : { user: this.toUserView(user), session };
  }

  /**
   * Keep a reloaded browser's CSRF token synchronized with its still-valid session.
   * Invalid, expired, or revoked sessions remain anonymous and are never updated.
   */
  async rotateSessionCsrfToken(
    sessionToken: string | undefined,
    csrfToken: CsrfToken,
  ): Promise<boolean> {
    const principal = this.authenticateSession(sessionToken);
    if (principal === null) {
      return false;
    }

    const now = this.dependencies.clock.now().toISOString();
    return this.dependencies.repository.withTransaction(async () =>
      this.dependencies.repository.updateSessionCsrfToken(
        principal.session.sessionId,
        hashToken(csrfToken),
        now,
      ),
    );
  }

  async logout(principal: AuthenticatedPrincipal): Promise<void> {
    const now = this.dependencies.clock.now();
    await this.dependencies.repository.withTransaction(async () => {
      if (
        !this.dependencies.sessions.revokeSession(principal.session.sessionId, now.toISOString())
      ) {
        throw new DomainError('unauthorized', 'The session is no longer active.');
      }
      await this.recordAudit('auth.logged_out', principal.user.id, now);
    });
  }

  private async recordAudit(
    action: 'auth.registered' | 'auth.logged_in' | 'auth.logged_out',
    actorId: UserId,
    occurredAt: Date,
  ): Promise<void> {
    await this.dependencies.auditSink.append({ action, actorId, occurredAt });
  }

  private toSessionResult(user: UserRecord, issued: IssuedSession): AuthSessionResult {
    return {
      user: this.toUserView(user),
      sessionToken: issued.token,
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt,
    };
  }

  private toUserView(user: UserRecord): AuthUserView {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }
}

export type { SessionToken };
