export type AuthRole = 'student' | 'instructor';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: AuthRole;
  readonly authProvider?: 'local' | 'supabase';
}

export interface CredentialsInput {
  readonly email: string;
  readonly password: string;
}

export interface AuthSessionResponse {
  readonly user: AuthUser;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface CurrentUserResponse {
  readonly user: AuthUser;
}

export interface CsrfResponse {
  readonly csrfToken: string;
}

export type AuthProblemCode =
  'unauthorized' | 'forbidden' | 'invalid_state' | 'validation_failed' | 'conflict';

/** Whitelisted machine-readable detail codes sent by the API alongside a generic problem. */
export type AuthProblemReason =
  | 'email_not_confirmed'
  | 'invalid_credentials'
  | 'weak_password'
  | 'same_password'
  | 'link_invalid'
  | 'recovery_expired'
  | 'rate_limited'
  | 'supabase_required'
  | 'provider_unavailable';

const knownReasons: ReadonlySet<string> = new Set<AuthProblemReason>([
  'email_not_confirmed',
  'invalid_credentials',
  'weak_password',
  'same_password',
  'link_invalid',
  'recovery_expired',
  'rate_limited',
  'supabase_required',
  'provider_unavailable',
]);

export interface AuthProblem {
  readonly code: AuthProblemCode;
  readonly message: string;
  readonly reason?: AuthProblemReason;
}

export interface PendingConfirmationResponse {
  readonly status: 'confirmation_sent';
}

export type RegisterResponse = AuthSessionResponse | PendingConfirmationResponse;

export type ConfirmResponse =
  | (AuthSessionResponse & { readonly status: 'signed_in' | 'reset_required' })
  | { readonly status: 'email_changed' | 'email_change_pending' };

export type ConfirmLinkType =
  'email' | 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change';

/** Friendly copy for the API's detail codes; falls back to the supplied default. */
export function messageForProblem(error: unknown, fallback: string): string {
  const reason = error instanceof AuthApiError ? error.problem.reason : undefined;
  switch (reason) {
    case 'email_not_confirmed':
      return 'Your email is not confirmed yet. Open the confirmation link we emailed you, then sign in.';
    case 'invalid_credentials':
      return 'The email or password is incorrect.';
    case 'weak_password':
      return 'That password is too weak. Choose a longer, less common one.';
    case 'same_password':
      return 'Choose a password different from your current one.';
    case 'link_invalid':
      return 'This link is invalid or has expired. Request a new one and try again.';
    case 'recovery_expired':
      return 'The password reset window has expired. Request a new reset email.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'supabase_required':
      return 'Email features are not available on this server.';
    case 'provider_unavailable':
      return 'The sign-in service is unavailable right now. Please try again shortly.';
    default:
      return fallback;
  }
}

export class AuthApiError extends Error {
  constructor(readonly problem: AuthProblem) {
    super(problem.message);
    this.name = 'AuthApiError';
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const browserRequestSignal = 'exam-anti-cheat-browser';

export interface AuthApi {
  getCsrf(): Promise<CsrfResponse>;
  register(input: CredentialsInput): Promise<RegisterResponse>;
  login(input: CredentialsInput): Promise<AuthSessionResponse>;
  logout(): Promise<void>;
  currentUser(): Promise<AuthUser | null>;
  forgotPassword(email: string): Promise<void>;
  confirm(input: {
    readonly tokenHash: string;
    readonly type: ConfirmLinkType;
  }): Promise<ConfirmResponse>;
  resetPassword(password: string): Promise<void>;
  changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void>;
  changeEmail(input: {
    readonly newEmail: string;
    readonly currentPassword: string;
  }): Promise<PendingConfirmationResponse>;
}

const safeProblems: Readonly<Record<number, AuthProblem>> = {
  401: { code: 'unauthorized', message: 'Authentication is required.' },
  403: { code: 'forbidden', message: 'You do not have permission to perform this action.' },
};

const fallbackProblem: AuthProblem = {
  code: 'invalid_state',
  message: 'The request could not be completed.',
};

function problemForStatus(status: number): AuthProblem {
  return safeProblems[status] ?? fallbackProblem;
}

async function problemFromResponse(response: Response): Promise<AuthProblem> {
  const base = problemForStatus(response.status);
  try {
    const body = (await response.json()) as { reason?: unknown } | null;
    const reason = body?.reason;
    if (typeof reason === 'string' && knownReasons.has(reason)) {
      return { ...base, reason: reason as AuthProblemReason };
    }
  } catch {
    // Non-JSON bodies keep the generic problem.
  }
  return base;
}

function isAuthUser(value: unknown): value is AuthUser {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.email === 'string' &&
    (candidate.role === 'student' || candidate.role === 'instructor')
  );
}

function isAuthSessionResponse(value: unknown): value is AuthSessionResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isAuthUser(candidate.user) &&
    typeof candidate.csrfToken === 'string' &&
    typeof candidate.expiresAt === 'string'
  );
}

function isPendingConfirmation(value: unknown): value is PendingConfirmationResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).status === 'confirmation_sent'
  );
}

function isCsrfResponse(value: unknown): value is CsrfResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).csrfToken === 'string'
  );
}

function isCurrentUserResponse(value: unknown): value is CurrentUserResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    isAuthUser((value as Record<string, unknown>).user)
  );
}

export class BrowserAuthApi implements AuthApi {
  private csrfToken: string | undefined;
  private readonly baseUrl: string;

  constructor(
    baseUrl = '',
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
  }

  async getCsrf(): Promise<CsrfResponse> {
    const body = await this.request('/auth/csrf', 'GET', undefined, false, true);
    if (!isCsrfResponse(body)) {
      throw new AuthApiError(fallbackProblem);
    }

    this.csrfToken = body.csrfToken;
    return body;
  }

  async register(input: CredentialsInput): Promise<RegisterResponse> {
    const body = await this.request('/auth/register', 'POST', input, true);
    if (isPendingConfirmation(body)) {
      return body;
    }
    return this.acceptSession(body);
  }

  async forgotPassword(email: string): Promise<void> {
    await this.request('/auth/forgot-password', 'POST', { email }, true);
  }

  async confirm(input: {
    readonly tokenHash: string;
    readonly type: ConfirmLinkType;
  }): Promise<ConfirmResponse> {
    const body = await this.request(
      '/auth/confirm',
      'POST',
      { token_hash: input.tokenHash, type: input.type },
      true,
    );
    const status = (body as { status?: unknown } | null)?.status;
    if (status === 'email_changed' || status === 'email_change_pending') {
      return { status };
    }
    if (status === 'signed_in' || status === 'reset_required') {
      return { ...this.acceptSession(body), status };
    }
    throw new AuthApiError(fallbackProblem);
  }

  async resetPassword(password: string): Promise<void> {
    await this.request('/auth/reset-password', 'POST', { password }, true);
  }

  async changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    await this.request('/auth/change-password', 'POST', input, true);
  }

  async changeEmail(input: {
    readonly newEmail: string;
    readonly currentPassword: string;
  }): Promise<PendingConfirmationResponse> {
    const body = await this.request('/auth/change-email', 'POST', input, true);
    if (!isPendingConfirmation(body)) {
      throw new AuthApiError(fallbackProblem);
    }
    return body;
  }

  async login(input: CredentialsInput): Promise<AuthSessionResponse> {
    const body = await this.request('/auth/login', 'POST', input, true);
    return this.acceptSession(body);
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', 'POST', undefined, true);
    this.csrfToken = undefined;
  }

  async currentUser(): Promise<AuthUser | null> {
    try {
      const body = await this.request('/auth/me', 'GET');
      if (!isCurrentUserResponse(body)) {
        throw new AuthApiError(fallbackProblem);
      }
      return body.user;
    } catch (error) {
      if (error instanceof AuthApiError && error.problem.code === 'unauthorized') {
        return null;
      }
      throw error;
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: object,
    unsafe = false,
    includeBrowserRequestSignal = false,
  ): Promise<unknown> {
    if (unsafe && this.csrfToken === undefined) {
      await this.getCsrf();
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (includeBrowserRequestSignal) {
      headers['x-requested-with'] = browserRequestSignal;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (unsafe && this.csrfToken !== undefined) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    const init: RequestInit = {
      credentials: 'include',
      headers,
      method,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new AuthApiError(await problemFromResponse(response));
    }

    if (response.status === 204) {
      return undefined;
    }

    try {
      return await response.json();
    } catch {
      throw new AuthApiError(fallbackProblem);
    }
  }

  private acceptSession(body: unknown): AuthSessionResponse {
    if (!isAuthSessionResponse(body)) {
      throw new AuthApiError(fallbackProblem);
    }

    this.csrfToken = body.csrfToken;
    return body;
  }
}

export function createAuthApi(baseUrl = '', fetchImpl?: FetchLike): AuthApi {
  return new BrowserAuthApi(baseUrl, fetchImpl);
}
