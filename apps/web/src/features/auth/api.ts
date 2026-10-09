export type AuthRole = 'student' | 'instructor';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: AuthRole;
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

export type AuthProblemCode = 'unauthorized' | 'forbidden' | 'invalid_state';

export interface AuthProblem {
  readonly code: AuthProblemCode;
  readonly message: string;
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
  register(input: CredentialsInput): Promise<AuthSessionResponse>;
  login(input: CredentialsInput): Promise<AuthSessionResponse>;
  logout(): Promise<void>;
  currentUser(): Promise<AuthUser | null>;
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

  async register(input: CredentialsInput): Promise<AuthSessionResponse> {
    const body = await this.request('/auth/register', 'POST', input, true);
    return this.acceptSession(body);
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
    body?: CredentialsInput,
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
      throw new AuthApiError(problemForStatus(response.status));
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
