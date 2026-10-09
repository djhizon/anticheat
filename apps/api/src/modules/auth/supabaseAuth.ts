/**
 * Minimal Supabase Auth (GoTrue) REST client. No SDK dependency; `fetch` is injectable so
 * tests never reach a live project. Tokens returned here are used transiently by the caller
 * and must never be persisted or sent to the browser.
 */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface SupabaseAuthSettings {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey?: string | undefined;
}

export interface SupabaseUser {
  readonly id: string;
  readonly email: string;
  /** Set while an email change is waiting for confirmation. */
  readonly newEmail: string | undefined;
}

export interface SupabaseSignUpResult {
  readonly user: SupabaseUser | null;
  /** Present only when the project has "Confirm email" disabled. */
  readonly accessToken: string | undefined;
}

export interface SupabaseTokenResult {
  readonly user: SupabaseUser;
  readonly accessToken: string;
}

export type SupabaseVerifyType =
  'email' | 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change';

export class SupabaseAuthError extends Error {
  constructor(
    /** HTTP status, or 0 for network failures. */
    readonly status: number,
    /** GoTrue `error_code` (for example `invalid_credentials`) or a synthetic code. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupabaseAuthError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readUser(value: unknown): SupabaseUser | null {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || typeof record.email !== 'string') {
    return null;
  }
  const newEmail =
    typeof record.new_email === 'string' && record.new_email !== '' ? record.new_email : undefined;
  return { id: record.id, email: record.email.trim().toLowerCase(), newEmail };
}

function parseErrorCode(status: number, body: Record<string, unknown> | null): string {
  const message = String(body?.msg ?? body?.message ?? body?.error_description ?? '');
  if (typeof body?.error_code === 'string') {
    return body.error_code;
  }
  if (/not confirmed/iu.test(message)) {
    return 'email_not_confirmed';
  }
  if (/invalid login credentials/iu.test(message)) {
    return 'invalid_credentials';
  }
  if (typeof body?.error === 'string') {
    return body.error;
  }
  return status === 429 ? 'over_request_rate_limit' : `http_${status}`;
}

export class SupabaseAuthClient {
  private readonly baseUrl: string;

  constructor(
    private readonly settings: SupabaseAuthSettings,
    private readonly fetchImpl: FetchImpl = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = `${settings.url.replace(/\/+$/u, '')}/auth/v1`;
  }

  get hasServiceRole(): boolean {
    return this.settings.serviceRoleKey !== undefined;
  }

  async signUp(email: string, password: string, redirectTo: string): Promise<SupabaseSignUpResult> {
    const body = await this.request('/signup', {
      method: 'POST',
      key: this.settings.anonKey,
      query: { redirect_to: redirectTo },
      body: { email, password },
    });
    const record = asRecord(body);
    const accessToken =
      typeof record?.access_token === 'string' && record.access_token !== ''
        ? record.access_token
        : undefined;
    // With a session, the user is nested; without one, the response is the user itself.
    const user = readUser(record?.user) ?? readUser(body);
    return { user, accessToken };
  }

  async signInWithPassword(email: string, password: string): Promise<SupabaseTokenResult> {
    const body = await this.request('/token', {
      method: 'POST',
      key: this.settings.anonKey,
      query: { grant_type: 'password' },
      body: { email, password },
    });
    return this.readTokenResult(body);
  }

  async recover(email: string, redirectTo: string): Promise<void> {
    await this.request('/recover', {
      method: 'POST',
      key: this.settings.anonKey,
      query: { redirect_to: redirectTo },
      body: { email },
    });
  }

  async verify(type: SupabaseVerifyType, tokenHash: string): Promise<SupabaseTokenResult> {
    const body = await this.request('/verify', {
      method: 'POST',
      key: this.settings.anonKey,
      body: { type, token_hash: tokenHash },
    });
    return this.readTokenResult(body);
  }

  async updateUser(
    accessToken: string,
    changes: { readonly password?: string; readonly email?: string },
    redirectTo?: string,
  ): Promise<SupabaseUser | null> {
    const body = await this.request('/user', {
      method: 'PUT',
      key: this.settings.anonKey,
      bearer: accessToken,
      ...(redirectTo === undefined ? {} : { query: { redirect_to: redirectTo } }),
      body: changes,
    });
    return readUser(body);
  }

  /** Create a pre-confirmed user (demo seed only). */
  async adminCreateUser(email: string, password: string): Promise<SupabaseUser> {
    const body = await this.request('/admin/users', {
      method: 'POST',
      key: this.requireServiceKey(),
      body: { email, password, email_confirm: true },
    });
    const user = readUser(body);
    if (user === null) {
      throw new SupabaseAuthError(502, 'invalid_response', 'Unexpected Supabase response.');
    }
    return user;
  }

  async adminFindUserByEmail(email: string): Promise<SupabaseUser | null> {
    const wanted = email.trim().toLowerCase();
    for (let page = 1; page <= 50; page += 1) {
      const body = await this.request('/admin/users', {
        method: 'GET',
        key: this.requireServiceKey(),
        query: { page: String(page), per_page: '200' },
      });
      const users = asRecord(body)?.users;
      if (!Array.isArray(users) || users.length === 0) {
        return null;
      }
      for (const candidate of users) {
        const user = readUser(candidate);
        if (user?.email === wanted) {
          return user;
        }
      }
      if (users.length < 200) {
        return null;
      }
    }
    return null;
  }

  async adminUpdateUser(id: string, password: string): Promise<void> {
    await this.request(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      key: this.requireServiceKey(),
      body: { password, email_confirm: true },
    });
  }

  private requireServiceKey(): string {
    if (this.settings.serviceRoleKey === undefined) {
      throw new SupabaseAuthError(0, 'service_key_missing', 'SUPABASE_SERVICE_ROLE_KEY is unset.');
    }
    return this.settings.serviceRoleKey;
  }

  private readTokenResult(body: unknown): SupabaseTokenResult {
    const record = asRecord(body);
    const user = readUser(record?.user);
    if (user === null || typeof record?.access_token !== 'string' || record.access_token === '') {
      throw new SupabaseAuthError(502, 'invalid_response', 'Unexpected Supabase response.');
    }
    return { user, accessToken: record.access_token };
  }

  private async request(
    path: string,
    options: {
      readonly method: 'GET' | 'POST' | 'PUT';
      readonly key: string;
      readonly bearer?: string;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    },
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      apikey: options.key,
    };
    // Legacy JWT keys double as bearer tokens; new `sb_*` keys are not JWTs and go in apikey only.
    const bearer = options.bearer ?? (options.key.startsWith('sb_') ? undefined : options.key);
    if (bearer !== undefined) {
      headers.authorization = `Bearer ${bearer}`;
    }
    const init: RequestInit = { method: options.method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), init);
    } catch {
      throw new SupabaseAuthError(0, 'network_error', 'Supabase Auth is unreachable.');
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const record = asRecord(parsed);
      throw new SupabaseAuthError(
        response.status,
        parseErrorCode(response.status, record),
        String(record?.msg ?? record?.message ?? record?.error_description ?? 'Request failed.'),
      );
    }
    return parsed;
  }
}
