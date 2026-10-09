import { DomainError, SystemClock, type Clock, type UserRole } from '@exam-anti-cheat/contracts';
import type { DatabaseSync } from 'node:sqlite';

import { loadConfig, type ApiConfig } from '../../config.js';
import { openDatabase } from '../../db/client.js';
import { SqliteAuthRepository, SqliteAuditSink } from './auth.repository.js';
import { AuthRoutes } from './auth.routes.js';
import { AuthService, type AuthenticatedPrincipal } from './auth.service.js';
import {
  getCookie,
  isAllowedOrigin,
  verifyDoubleSubmitToken,
  verifySessionCsrfToken,
} from './csrf.js';
import { SecureTokenGenerator, SessionService } from './session.js';
import { SupabaseAuthClient, type FetchImpl } from './supabaseAuth.js';

export type RequestHeaders = Readonly<Record<string, string | undefined>>;

export interface AuthRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: RequestHeaders;
  readonly body?: unknown;
  /** Socket peer address; used only for in-memory rate limiting. */
  readonly remoteAddress?: string;
}

export function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function isUnsafeMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export class AuthRequestBoundary {
  constructor(
    private readonly authService: AuthService,
    private readonly config: Pick<
      ApiConfig,
      'allowedOrigins' | 'sessionCookieName' | 'csrfCookieName' | 'csrfHeaderName'
    >,
  ) {}

  /**
   * Resolve the session's principal. A session minted by a password-recovery link is reset-only:
   * it is rejected everywhere unless the route opts in with `allowResetOnly`.
   */
  requirePrincipal(
    request: AuthRequest,
    options: { readonly allowResetOnly?: boolean } = {},
  ): AuthenticatedPrincipal {
    const sessionToken = getCookie(
      headerValue(request.headers, 'cookie'),
      this.config.sessionCookieName,
    );
    const principal = this.authService.authenticateSession(sessionToken);
    if (principal === null) {
      throw new DomainError('unauthorized', 'The session is invalid or expired.');
    }

    if (principal.resetRequired && options.allowResetOnly !== true) {
      throw new DomainError('forbidden', 'Finish resetting your password first.', {
        reason: 'reset_required',
      });
    }

    return principal;
  }

  requireRole(principal: AuthenticatedPrincipal, role: UserRole): void {
    if (principal.user.role !== role) {
      throw new DomainError('forbidden', 'The current role is not allowed for this operation.');
    }
  }

  validateUnsafe(request: AuthRequest, principal?: AuthenticatedPrincipal): void {
    const method = request.method.toUpperCase();
    if (!isUnsafeMethod(method)) {
      return;
    }

    const origin = headerValue(request.headers, 'origin');
    if (!isAllowedOrigin(origin, this.config.allowedOrigins)) {
      throw new DomainError('forbidden', 'The request origin is not allowed.');
    }

    const headerToken = headerValue(request.headers, this.config.csrfHeaderName);
    if (principal === undefined) {
      const cookieToken = getCookie(
        headerValue(request.headers, 'cookie'),
        this.config.csrfCookieName,
      );
      if (!verifyDoubleSubmitToken(headerToken, cookieToken)) {
        throw new DomainError('forbidden', 'The CSRF token is invalid.');
      }
      return;
    }

    if (!verifySessionCsrfToken(headerToken, principal.session.csrfTokenHash)) {
      throw new DomainError('forbidden', 'The CSRF token is invalid.');
    }
  }
}

export interface AuthPlugin {
  readonly database: DatabaseSync;
  readonly repository: SqliteAuthRepository;
  readonly sessions: SessionService;
  readonly service: AuthService;
  readonly supabase: SupabaseAuthClient | undefined;
  readonly boundary: AuthRequestBoundary;
  readonly routes: AuthRoutes;
  close(): void;
}

export interface AuthPluginOptions {
  /** Injected in tests so no request ever reaches a live Supabase project. */
  readonly fetchImpl?: FetchImpl;
  readonly clock?: Clock;
}

export function createAuthPlugin(
  config: ApiConfig = loadConfig(),
  options: AuthPluginOptions = {},
): AuthPlugin {
  const database = openDatabase(config.databasePath);
  const repository = new SqliteAuthRepository(database);
  const auditSink = new SqliteAuditSink(database);
  const tokenGenerator = new SecureTokenGenerator();
  const clock = options.clock ?? new SystemClock();
  const sessions = new SessionService(repository, clock, config.sessionTtlSeconds, tokenGenerator);
  const supabase =
    config.supabaseUrl !== undefined && config.supabaseAnonKey !== undefined
      ? new SupabaseAuthClient(
          { url: config.supabaseUrl, anonKey: config.supabaseAnonKey },
          options.fetchImpl,
        )
      : undefined;
  const service = new AuthService({
    repository,
    sessions,
    clock,
    auditSink,
    idGenerator: tokenGenerator,
    ...(supabase === undefined ? {} : { supabase }),
    siteUrl: config.siteUrl,
  });
  const boundary = new AuthRequestBoundary(service, config);
  const routes = new AuthRoutes(service, boundary, tokenGenerator, config);

  return {
    database,
    repository,
    sessions,
    service,
    supabase,
    boundary,
    routes,
    close: () => database.close(),
  };
}
