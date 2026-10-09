import { DomainError, problemFromError, type ProblemCode } from '@exam-anti-cheat/contracts';

import type { ApiConfig } from '../../config.js';
import { getCookie, isAllowedOrigin, issueCsrfToken } from './csrf.js';
import type { AuthRequest, AuthRequestBoundary } from './auth.plugin.js';
import type { AuthSessionResult, AuthService, CredentialsInput } from './auth.service.js';
import type { TokenGenerator } from './session.js';

export type ResponseHeaderValue = string | readonly string[];

export interface AuthResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, ResponseHeaderValue>>;
  readonly body: unknown;
}

const corsAllowedMethods = 'GET, POST, OPTIONS';
const corsAllowedHeaders = 'Content-Type, X-CSRF-Token, X-Requested-With';
const corsRequestMethods = new Set(['GET', 'POST']);
const corsRequestHeaders = new Set(['content-type', 'x-csrf-token', 'x-requested-with']);
const browserRequestSignal = 'exam-anti-cheat-browser';
const authPaths = new Set([
  '/auth/csrf',
  '/auth/register',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
]);

const problemStatus: Record<ProblemCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  invalid_state: 500,
};

function headerValue(request: AuthRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(request.headers).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function parseCredentials(body: unknown): CredentialsInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError('validation_failed', 'A credentials object is required.');
  }

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.email !== 'string' || typeof candidate.password !== 'string') {
    throw new DomainError('validation_failed', 'Email and password are required.');
  }

  return { email: candidate.email, password: candidate.password };
}

function jsonResponse(
  status: number,
  body: unknown,
  cookies: readonly string[] = [],
  extraHeaders: Readonly<Record<string, ResponseHeaderValue>> = {},
): AuthResponse {
  const headers: Record<string, ResponseHeaderValue> = {
    ...extraHeaders,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }

  return { status, headers, body };
}

function cookieValue(name: string, value: string, secure: boolean, maxAgeSeconds?: number): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) {
    attributes.push(`Max-Age=${maxAgeSeconds}`);
  }
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function clearedCookie(name: string, secure: boolean): string {
  return cookieValue(name, '', secure, 0);
}

function publicSession(result: AuthSessionResult): Omit<AuthSessionResult, 'sessionToken'> {
  return {
    user: result.user,
    csrfToken: result.csrfToken,
    expiresAt: result.expiresAt,
  };
}

function problemResponse(
  error: unknown,
  request: AuthRequest,
  allowedOrigins: readonly string[],
): AuthResponse {
  const problem = problemFromError(error);
  return {
    status: problemStatus[problem.code],
    headers: {
      ...corsHeaders(request, allowedOrigins),
      'cache-control': 'no-store',
      'content-type': 'application/problem+json',
    },
    body: problem,
  };
}

function corsHeaders(
  request: AuthRequest,
  allowedOrigins: readonly string[],
): Readonly<Record<string, ResponseHeaderValue>> {
  const headers: Record<string, ResponseHeaderValue> = { vary: 'Origin' };
  const origin = headerValue(request, 'origin');

  if (origin !== undefined && isAllowedOrigin(origin, allowedOrigins)) {
    // Credentialed CORS must echo a configured origin; wildcard origins are not allowed.
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-methods'] = corsAllowedMethods;
    headers['access-control-allow-headers'] = corsAllowedHeaders;
  }

  return headers;
}

function requestedHeadersAreAllowed(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return true;
  }

  return value
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== '')
    .every((header) => corsRequestHeaders.has(header));
}

export class AuthRoutes {
  constructor(
    private readonly authService: AuthService,
    private readonly boundary: AuthRequestBoundary,
    private readonly tokenGenerator: TokenGenerator,
    private readonly config: Pick<
      ApiConfig,
      | 'secureCookies'
      | 'sessionCookieName'
      | 'csrfCookieName'
      | 'sessionTtlSeconds'
      | 'allowedOrigins'
    >,
  ) {}

  async handle(request: AuthRequest): Promise<AuthResponse> {
    try {
      const method = request.method.toUpperCase();
      const path = request.path.split('?')[0] ?? request.path;

      if (method === 'OPTIONS') {
        return this.preflightResponse(request, path);
      }

      this.assertAllowedOrigin(request);

      if (method === 'GET' && path === '/auth/csrf') {
        return await this.csrfResponse(request);
      }

      if (method === 'POST' && path === '/auth/register') {
        this.boundary.validateUnsafe(request);
        const result = await this.authService.register(parseCredentials(request.body));
        return this.respond(request, 201, publicSession(result), this.sessionCookies(result));
      }

      if (method === 'POST' && path === '/auth/login') {
        this.boundary.validateUnsafe(request);
        const result = await this.authService.login(
          parseCredentials(request.body),
          getCookie(headerValue(request, 'cookie'), this.config.sessionCookieName),
        );
        return this.respond(request, 200, publicSession(result), this.sessionCookies(result));
      }

      if (method === 'POST' && path === '/auth/logout') {
        const principal = this.boundary.requirePrincipal(request);
        this.boundary.validateUnsafe(request, principal);
        await this.authService.logout(principal);
        return this.respond(request, 204, null, [
          clearedCookie(this.config.sessionCookieName, this.config.secureCookies),
          clearedCookie(this.config.csrfCookieName, this.config.secureCookies),
        ]);
      }

      if (method === 'GET' && path === '/auth/me') {
        const principal = this.boundary.requirePrincipal(request);
        return this.respond(request, 200, { user: principal.user });
      }

      throw new DomainError('not_found', 'The requested authentication route does not exist.');
    } catch (error) {
      return problemResponse(error, request, this.config.allowedOrigins);
    }
  }

  private respond(
    request: AuthRequest,
    status: number,
    body: unknown,
    cookies: readonly string[] = [],
  ): AuthResponse {
    return jsonResponse(status, body, cookies, corsHeaders(request, this.config.allowedOrigins));
  }

  private async csrfResponse(request: AuthRequest): Promise<AuthResponse> {
    const csrfToken = issueCsrfToken(this.tokenGenerator);
    const origin = headerValue(request, 'origin');
    if (
      (origin !== undefined && isAllowedOrigin(origin, this.config.allowedOrigins)) ||
      headerValue(request, 'x-requested-with') === browserRequestSignal
    ) {
      // Only an allowed origin or the exact browser signal may rotate an active session on GET.
      await this.authService.rotateSessionCsrfToken(
        getCookie(headerValue(request, 'cookie'), this.config.sessionCookieName),
        csrfToken,
      );
    }

    return this.respond(request, 200, { csrfToken }, [
      cookieValue(
        this.config.csrfCookieName,
        csrfToken,
        this.config.secureCookies,
        this.config.sessionTtlSeconds,
      ),
    ]);
  }

  private assertAllowedOrigin(request: AuthRequest): void {
    const origin = headerValue(request, 'origin');
    if (origin !== undefined && !isAllowedOrigin(origin, this.config.allowedOrigins)) {
      throw new DomainError('forbidden', 'The request origin is not allowed.');
    }
  }

  private preflightResponse(request: AuthRequest, path: string): AuthResponse {
    if (!authPaths.has(path)) {
      throw new DomainError('not_found', 'The requested authentication route does not exist.');
    }

    this.assertAllowedOrigin(request);
    const requestedMethod = headerValue(request, 'access-control-request-method')?.toUpperCase();
    if (requestedMethod === undefined || !corsRequestMethods.has(requestedMethod)) {
      throw new DomainError('forbidden', 'The requested CORS method is not allowed.');
    }
    if (!requestedHeadersAreAllowed(headerValue(request, 'access-control-request-headers'))) {
      throw new DomainError('forbidden', 'The requested CORS headers are not allowed.');
    }

    return {
      status: 204,
      headers: corsHeaders(request, this.config.allowedOrigins),
      body: null,
    };
  }

  private sessionCookies(result: AuthSessionResult): readonly string[] {
    return [
      cookieValue(
        this.config.sessionCookieName,
        result.sessionToken,
        this.config.secureCookies,
        this.config.sessionTtlSeconds,
      ),
      cookieValue(
        this.config.csrfCookieName,
        result.csrfToken,
        this.config.secureCookies,
        this.config.sessionTtlSeconds,
      ),
    ];
  }
}
