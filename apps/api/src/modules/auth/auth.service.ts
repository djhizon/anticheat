import {
  DomainError,
  type AuditSink,
  type Clock,
  type UserId,
  type UserRole,
} from '@examguard/contracts';

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
import {
  EXTERNAL_PASSWORD_HASH,
  SqliteAuthRepository,
  type UserRecord,
} from './auth.repository.js';
import { AttemptLimiter, PendingRecoveryStore } from './recoveryStore.js';
import {
  SupabaseAuthClient,
  SupabaseAuthError,
  type SupabaseUser,
  type SupabaseVerifyType,
} from './supabaseAuth.js';

export interface CredentialsInput {
  readonly email: string;
  readonly password: string;
}

export interface AuthUserView {
  readonly id: UserId;
  readonly email: string;
  readonly role: UserRole;
  /** Which identity system owns this account's password and email flows. */
  readonly authProvider: 'local' | 'supabase';
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
  /** True while the session only exists to finish a password-recovery reset. */
  readonly resetRequired: boolean;
}

export interface AuthServiceDependencies {
  readonly repository: SqliteAuthRepository;
  readonly sessions: SessionService;
  readonly clock: Clock;
  readonly auditSink: AuditSink;
  readonly idGenerator?: TokenGenerator;
  /** When set, sign-up/sign-in/email flows are delegated to Supabase Auth. */
  readonly supabase?: SupabaseAuthClient;
  /** Public web origin; emails link to `${siteUrl}/account/confirm`. */
  readonly siteUrl?: string;
}

export interface PendingConfirmationResult {
  readonly status: 'confirmation_sent';
}

export type ConfirmResult =
  | { readonly status: 'signed_in' | 'reset_required'; readonly session: AuthSessionResult }
  | { readonly status: 'email_changed' | 'email_change_pending' };

export const CONFIRM_TYPES: readonly SupabaseVerifyType[] = [
  'email',
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
];

/** Safe, whitelisted detail codes the web UI can turn into friendly messages. */
export type ProblemReason =
  | 'email_not_confirmed'
  | 'invalid_credentials'
  | 'weak_password'
  | 'same_password'
  | 'link_invalid'
  | 'recovery_expired'
  | 'rate_limited'
  | 'supabase_required'
  | 'provider_unavailable'
  | 'reset_required';

/** Per client+email limit for mail-sending endpoints. */
const FORGOT_LIMIT = 3;
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
/** Per email address alone, regardless of the requesting client. */
const EMAIL_SEND_LIMIT = 3;
/** Across all clients and addresses, to bound total outbound mail. */
const GLOBAL_SEND_LIMIT = 30;
/** Wrong-password attempts allowed per key before a lockout until the window ends. */
const PASSWORD_FAILURE_LIMIT = 5;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function reasoned(
  code: ConstructorParameters<typeof DomainError>[0],
  message: string,
  reason: ProblemReason,
): DomainError {
  return new DomainError(code, message, { reason });
}

function validateEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (!emailPattern.test(email) || email.length > 320) {
    throw new DomainError('validation_failed', 'Email address is invalid.');
  }
  return email;
}

function validatePassword(password: string): void {
  if (password.length === 0 || password.length > 1024) {
    throw new DomainError('validation_failed', 'Password length is outside the supported range.');
  }
}

function validateCredentials(input: CredentialsInput): string {
  const email = validateEmail(input.email);
  validatePassword(input.password);
  return email;
}

function supabaseRequired(): DomainError {
  return reasoned('invalid_state', 'Email features need Supabase configured', 'supabase_required');
}

function mapSupabaseError(error: unknown): unknown {
  if (!(error instanceof SupabaseAuthError)) {
    return error;
  }
  switch (error.code) {
    case 'email_not_confirmed':
      return reasoned('forbidden', 'Email address is not confirmed.', 'email_not_confirmed');
    case 'invalid_credentials':
    case 'invalid_grant':
      return reasoned(
        'unauthorized',
        'The supplied credentials are not valid.',
        'invalid_credentials',
      );
    case 'weak_password':
      return reasoned('validation_failed', 'The password is too weak.', 'weak_password');
    case 'same_password':
      return reasoned('validation_failed', 'The new password must differ.', 'same_password');
    case 'user_already_exists':
    case 'email_exists':
      return new DomainError('conflict', 'An account already exists for this email address.');
    case 'otp_expired':
    case 'bad_jwt':
    case 'validation_failed':
      return reasoned('validation_failed', 'The link is invalid or has expired.', 'link_invalid');
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return reasoned('invalid_state', 'Too many requests.', 'rate_limited');
    default:
      if (error.status === 429) {
        return reasoned('invalid_state', 'Too many requests.', 'rate_limited');
      }
      if (error.status === 403 || error.status === 401) {
        return reasoned('validation_failed', 'The link is invalid or has expired.', 'link_invalid');
      }
      return reasoned('invalid_state', 'Identity provider unavailable.', 'provider_unavailable');
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export class AuthService {
  private readonly idGenerator: TokenGenerator;
  private readonly recovery = new PendingRecoveryStore();
  private readonly forgotLimiter = new AttemptLimiter(FORGOT_LIMIT, FORGOT_WINDOW_MS);
  private readonly registerLimiter = new AttemptLimiter(FORGOT_LIMIT, FORGOT_WINDOW_MS);
  private readonly emailSendLimiter = new AttemptLimiter(EMAIL_SEND_LIMIT, FORGOT_WINDOW_MS);
  private readonly globalSendLimiter = new AttemptLimiter(GLOBAL_SEND_LIMIT, FORGOT_WINDOW_MS, 1);
  private readonly passwordFailures = new AttemptLimiter(PASSWORD_FAILURE_LIMIT, FORGOT_WINDOW_MS);

  constructor(private readonly dependencies: AuthServiceDependencies) {
    this.idGenerator = dependencies.idGenerator ?? new SecureTokenGenerator();
  }

  get provider(): 'local' | 'supabase' {
    return this.dependencies.supabase === undefined ? 'local' : 'supabase';
  }

  /** Provider-aware sign-up used by the HTTP routes. */
  async signUp(
    input: CredentialsInput,
    clientKey = 'unknown',
  ): Promise<AuthSessionResult | PendingConfirmationResult> {
    const supabase = this.dependencies.supabase;
    if (supabase === undefined) {
      return this.register(input);
    }

    const email = validateCredentials(input);
    // Every outcome below the validation step looks identical to the caller, so the response
    // cannot be used to learn whether an address already has an account.
    const generic: PendingConfirmationResult = { status: 'confirmation_sent' };
    if (!this.takeEmailSend(this.registerLimiter, clientKey, email)) {
      return generic;
    }
    if (this.dependencies.repository.findUserByEmail(email) !== null) {
      return generic;
    }

    let result;
    try {
      result = await supabase.signUp(email, input.password, this.confirmUrl());
    } catch (error) {
      if (
        error instanceof SupabaseAuthError &&
        (error.code === 'user_already_exists' || error.code === 'email_exists')
      ) {
        return generic;
      }
      throw mapSupabaseError(error);
    }
    if (result.accessToken === undefined || result.user === null) {
      return { status: 'confirmation_sent' };
    }
    return this.signInExternalUser(result.user);
  }

  /**
   * Local-only registration (Argon2 hash in this database). Kept for offline use and the
   * demo seed; provider-aware callers should use {@link signUp}.
   */
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
      authProvider: 'local',
      externalId: null,
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
    const failureKey = `login|${email}`;
    this.assertNotThrottled(failureKey);
    const user = this.dependencies.repository.findUserByEmail(email);
    const supabase = this.dependencies.supabase;
    if (supabase !== undefined && (user === null || user.authProvider === 'supabase')) {
      let token;
      try {
        token = await supabase.signInWithPassword(email, input.password);
      } catch (error) {
        const mapped = mapSupabaseError(error);
        if (mapped instanceof DomainError && mapped.code === 'unauthorized') {
          this.recordPasswordFailure(failureKey);
        }
        throw mapped;
      }
      this.passwordFailures.reset(failureKey);
      return this.signInExternalUser(token.user, previousSessionToken);
    }

    if (user === null || !(await verifyPassword(input.password, user.passwordHash))) {
      this.recordPasswordFailure(failureKey);
      throw new DomainError('unauthorized', 'The supplied credentials are not valid.');
    }
    this.passwordFailures.reset(failureKey);

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

  /** Never reveals whether the email has an account; provider errors are swallowed. */
  async forgotPassword(rawEmail: string, clientKey: string): Promise<void> {
    const supabase = this.dependencies.supabase;
    if (supabase === undefined) {
      throw supabaseRequired();
    }
    const email = validateEmail(rawEmail);
    if (!this.takeEmailSend(this.forgotLimiter, clientKey, email)) {
      return;
    }
    try {
      await supabase.recover(email, this.confirmUrl());
    } catch {
      // Intentionally ignored so responses cannot be used to probe accounts.
    }
  }

  async confirm(
    input: { readonly tokenHash: string; readonly type: string },
    previousSessionToken?: string,
  ): Promise<ConfirmResult> {
    const supabase = this.dependencies.supabase;
    if (supabase === undefined) {
      throw supabaseRequired();
    }
    const type = CONFIRM_TYPES.find((candidate) => candidate === input.type);
    if (type === undefined || input.tokenHash.length === 0 || input.tokenHash.length > 512) {
      throw reasoned('validation_failed', 'The link is invalid or has expired.', 'link_invalid');
    }

    let verified;
    try {
      verified = await supabase.verify(type, input.tokenHash);
    } catch (error) {
      throw mapSupabaseError(error);
    }

    if (type === 'email_change') {
      if (verified.user.newEmail !== undefined) {
        return { status: 'email_change_pending' };
      }
      const existing = this.dependencies.repository.findUserByExternalId(verified.user.id);
      if (existing !== null && existing.email !== verified.user.email) {
        try {
          this.dependencies.repository.updateEmail(existing.id, verified.user.email);
          // A changed address invalidates every session that was opened under the old one.
          this.dependencies.repository.revokeAllSessionsForUser(
            existing.id,
            undefined,
            this.dependencies.clock.now().toISOString(),
          );
        } catch (error) {
          if (isUniqueConstraint(error)) {
            throw new DomainError('conflict', 'An account already exists for this email address.');
          }
          throw error;
        }
      }
      return { status: 'email_changed' };
    }

    const session = await this.signInExternalUser(
      verified.user,
      previousSessionToken,
      type === 'recovery' ? verified.accessToken : undefined,
    );
    return { status: type === 'recovery' ? 'reset_required' : 'signed_in', session };
  }

  async resetPassword(principal: AuthenticatedPrincipal, password: string): Promise<void> {
    const supabase = this.dependencies.supabase;
    if (supabase === undefined) {
      throw supabaseRequired();
    }
    validatePassword(password);
    const accessToken = this.recovery.peek(
      principal.session.sessionId,
      this.dependencies.clock.now().getTime(),
    );
    if (accessToken === null) {
      throw reasoned('forbidden', 'The password reset has expired.', 'recovery_expired');
    }
    try {
      await supabase.updateUser(accessToken, { password });
    } catch (error) {
      throw mapSupabaseError(error);
    }
    this.recovery.delete(principal.session.sessionId);
    this.revokeOtherSessions(principal);
  }

  async changePassword(
    principal: AuthenticatedPrincipal,
    input: { readonly currentPassword: string; readonly newPassword: string },
  ): Promise<void> {
    validatePassword(input.currentPassword);
    validatePassword(input.newPassword);
    const user = this.dependencies.repository.findUserById(principal.user.id);
    if (user === null) {
      throw new DomainError('unauthorized', 'The session is no longer active.');
    }
    const failureKey = `user|${user.id}`;
    this.assertNotThrottled(failureKey);

    if (user.authProvider === 'supabase') {
      const supabase = this.dependencies.supabase;
      if (supabase === undefined) {
        throw supabaseRequired();
      }
      const accessToken = await this.reauthenticate(supabase, user, input.currentPassword);
      try {
        await supabase.updateUser(accessToken, { password: input.newPassword });
      } catch (error) {
        throw mapSupabaseError(error);
      }
      this.revokeOtherSessions(principal);
      return;
    }

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      this.recordPasswordFailure(failureKey);
      throw reasoned('forbidden', 'The current password is incorrect.', 'invalid_credentials');
    }
    this.passwordFailures.reset(failureKey);
    this.dependencies.repository.updatePasswordHash(user.id, await hashPassword(input.newPassword));
    this.revokeOtherSessions(principal);
  }

  async changeEmail(
    principal: AuthenticatedPrincipal,
    input: { readonly newEmail: string; readonly currentPassword: string },
  ): Promise<PendingConfirmationResult> {
    const supabase = this.dependencies.supabase;
    if (supabase === undefined) {
      throw supabaseRequired();
    }
    const newEmail = validateEmail(input.newEmail);
    validatePassword(input.currentPassword);
    const user = this.dependencies.repository.findUserById(principal.user.id);
    if (user === null) {
      throw new DomainError('unauthorized', 'The session is no longer active.');
    }
    if (user.authProvider !== 'supabase') {
      throw supabaseRequired();
    }
    this.assertNotThrottled(`user|${user.id}`);
    const accessToken = await this.reauthenticate(supabase, user, input.currentPassword);
    // Checked only after the password proved who is asking, and before Supabase is told anything.
    if (this.dependencies.repository.findUserByEmail(newEmail) !== null) {
      throw new DomainError('conflict', 'An account already exists for this email address.');
    }
    try {
      await supabase.updateUser(accessToken, { email: newEmail }, this.confirmUrl());
    } catch (error) {
      throw mapSupabaseError(error);
    }
    return { status: 'confirmation_sent' };
  }

  /**
   * Map a Supabase identity to a local user, creating a student on first sight. With
   * `adoptLocalByEmail` an existing local account is converted (demo seed only).
   */
  provisionExternalUser(
    external: SupabaseUser,
    options: { readonly adoptLocalByEmail?: boolean } = {},
  ): UserRecord {
    const repository = this.dependencies.repository;
    const byExternal = repository.findUserByExternalId(external.id);
    if (byExternal !== null) {
      if (byExternal.email !== external.email) {
        repository.updateEmail(byExternal.id, external.email);
        return { ...byExternal, email: external.email };
      }
      return byExternal;
    }

    const byEmail = repository.findUserByEmail(external.email);
    if (byEmail !== null) {
      if (options.adoptLocalByEmail !== true) {
        throw new DomainError('conflict', 'An account already exists for this email address.');
      }
      repository.linkExternalIdentity(byEmail.id, external.id);
      return {
        ...byEmail,
        authProvider: 'supabase',
        externalId: external.id,
        passwordHash: EXTERNAL_PASSWORD_HASH,
      };
    }

    const user: UserRecord = {
      id: asAuthOpaqueId<'UserId'>(this.idGenerator.generate(32)),
      email: external.email,
      passwordHash: EXTERNAL_PASSWORD_HASH,
      role: 'student',
      createdAt: this.dependencies.clock.now().toISOString(),
      authProvider: 'supabase',
      externalId: external.id,
    };
    repository.insertUser(user);
    return user;
  }

  authenticateSession(sessionToken: string | undefined): AuthenticatedPrincipal | null {
    this.revokeExpiredRecoverySessions();
    const session = this.dependencies.sessions.authenticate(sessionToken);
    if (session === null) {
      return null;
    }

    const user = this.dependencies.repository.findUserById(session.userId);
    return user === null
      ? null
      : {
          user: this.toUserView(user),
          session,
          resetRequired: this.recovery.has(session.sessionId),
        };
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
    this.recovery.delete(principal.session.sessionId);
  }

  private async reauthenticate(
    supabase: SupabaseAuthClient,
    user: UserRecord,
    currentPassword: string,
  ): Promise<string> {
    try {
      const token = await supabase.signInWithPassword(user.email, currentPassword);
      this.passwordFailures.reset(`user|${user.id}`);
      return token.accessToken;
    } catch (error) {
      const mapped = mapSupabaseError(error);
      // A wrong current password here is a permission problem, not an expired session.
      if (mapped instanceof DomainError && mapped.code === 'unauthorized') {
        this.recordPasswordFailure(`user|${user.id}`);
        throw reasoned('forbidden', 'The current password is incorrect.', 'invalid_credentials');
      }
      throw mapped;
    }
  }

  private async signInExternalUser(
    external: SupabaseUser,
    previousSessionToken?: string,
    recoveryAccessToken?: string,
  ): Promise<AuthSessionResult> {
    const previousSession = this.dependencies.sessions.authenticate(previousSessionToken);
    const now = this.dependencies.clock.now();
    try {
      return await this.dependencies.repository.withTransaction(async () => {
        const existing = this.dependencies.repository.findUserByExternalId(external.id);
        const user = this.provisionExternalUser(external);
        if (previousSession !== null) {
          this.dependencies.sessions.revokeSession(previousSession.sessionId, now.toISOString());
        }
        const issued = this.dependencies.sessions.create(user.id);
        await this.recordAudit(
          existing === null ? 'auth.registered' : 'auth.logged_in',
          user.id,
          now,
        );
        if (recoveryAccessToken !== undefined) {
          this.recovery.set(issued.sessionId, recoveryAccessToken, now.getTime());
        }
        return this.toSessionResult(user, issued);
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new DomainError('conflict', 'An account already exists for this email address.');
      }
      throw error;
    }
  }

  /** Abandoned password resets lose their session once the recovery entry expires. */
  private revokeExpiredRecoverySessions(): void {
    const now = this.dependencies.clock.now();
    for (const sessionId of this.recovery.takeExpired(now.getTime())) {
      this.dependencies.sessions.revokeSession(sessionId, now.toISOString());
    }
  }

  private revokeOtherSessions(principal: AuthenticatedPrincipal): void {
    this.dependencies.repository.revokeAllSessionsForUser(
      principal.user.id,
      principal.session.sessionId,
      this.dependencies.clock.now().toISOString(),
    );
  }

  /** Per client+email, per email, and global caps for endpoints that send mail. */
  private takeEmailSend(clientLimiter: AttemptLimiter, clientKey: string, email: string): boolean {
    const nowMs = this.dependencies.clock.now().getTime();
    return (
      clientLimiter.take(`${clientKey}|${email}`, nowMs) &&
      this.emailSendLimiter.take(email, nowMs) &&
      this.globalSendLimiter.take('global', nowMs)
    );
  }

  private assertNotThrottled(key: string): void {
    if (this.passwordFailures.isLimited(key, this.dependencies.clock.now().getTime())) {
      throw reasoned('invalid_state', 'Too many attempts.', 'rate_limited');
    }
  }

  private recordPasswordFailure(key: string): void {
    this.passwordFailures.take(key, this.dependencies.clock.now().getTime());
  }

  private confirmUrl(): string {
    return `${this.dependencies.siteUrl ?? ''}/account/confirm`;
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
      authProvider: user.authProvider,
    };
  }
}

export type { SessionToken };
