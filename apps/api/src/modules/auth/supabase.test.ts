import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@exam-anti-cheat/contracts';

import { loadConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from './auth.plugin.js';
import { SupabaseAuthClient, SupabaseAuthError } from './supabaseAuth.js';

const origin = 'http://localhost:5173';
const baseUrl = 'https://proj.supabase.co';
const anonKey = 'sb_publishable_test';
const email = 'student@example.test';
const password = 'correct horse battery staple';

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Responder = (call: Call) => { status?: number; body?: unknown } | undefined;

function createMockFetch(responder: Responder): {
  readonly calls: Call[];
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: new URL(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const result = responder(call) ?? { status: 500, body: { msg: 'unexpected' } };
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

const user = (id = 'sb-user-1', userEmail = email, extra: object = {}) => ({
  id,
  email: userEmail,
  ...extra,
});

class MutableClock implements Clock {
  constructor(private current = new Date('2026-10-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface Csrf {
  readonly token: string;
  readonly cookie: string;
}

function cookieValue(
  response: { headers: Readonly<Record<string, string | readonly string[]>> },
  name: string,
): string {
  const raw = response.headers['set-cookie'];
  const list = raw === undefined ? [] : typeof raw === 'string' ? [raw] : raw;
  const found = list.find((value) => value.startsWith(`${name}=`));
  if (found === undefined) {
    throw new Error(`Missing ${name} cookie`);
  }
  return decodeURIComponent(found.slice(name.length + 1).split(';')[0] ?? '');
}

describe('Supabase identity provider', () => {
  const plugins: AuthPlugin[] = [];
  afterEach(() => {
    for (const plugin of plugins.splice(0)) {
      plugin.close();
    }
  });

  function setup(responder: Responder, env: Record<string, string> = {}, clock?: Clock) {
    const mock = createMockFetch(responder);
    const plugin = createAuthPlugin(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        ALLOWED_ORIGINS: origin,
        COOKIE_SECURE: 'false',
        SUPABASE_URL: baseUrl,
        SUPABASE_ANON_KEY: anonKey,
        ...env,
      }),
      { fetchImpl: mock.fetchImpl, ...(clock === undefined ? {} : { clock }) },
    );
    plugins.push(plugin);
    return { plugin, ...mock };
  }

  async function csrf(plugin: AuthPlugin): Promise<Csrf> {
    const response = await plugin.routes.handle({ method: 'GET', path: '/auth/csrf', headers: {} });
    return {
      token: (response.body as { csrfToken: string }).csrfToken,
      cookie: cookieValue(response, 'eac_csrf'),
    };
  }

  async function anonymous(
    plugin: AuthPlugin,
    path: string,
    body: unknown,
    remoteAddress = '10.0.0.1',
  ) {
    const token = await csrf(plugin);
    const request: AuthRequest = {
      method: 'POST',
      path,
      remoteAddress,
      headers: {
        origin,
        cookie: `eac_csrf=${encodeURIComponent(token.cookie)}`,
        'x-csrf-token': token.token,
      },
      body,
    };
    return plugin.routes.handle(request);
  }

  async function authed(
    plugin: AuthPlugin,
    session: { sessionToken: string; csrfToken: string },
    path: string,
    body: unknown,
  ) {
    return plugin.routes.handle({
      method: 'POST',
      path,
      headers: {
        origin,
        cookie: `eac_session=${encodeURIComponent(session.sessionToken)}`,
        'x-csrf-token': session.csrfToken,
      },
      body,
    });
  }

  function sessionOf(response: Awaited<ReturnType<typeof anonymous>>) {
    return {
      sessionToken: cookieValue(response, 'eac_session'),
      csrfToken: (response.body as { csrfToken: string }).csrfToken,
    };
  }

  const passwordGrant: Responder = (call) =>
    call.url.pathname === '/auth/v1/token'
      ? call.body && (call.body as { password: string }).password === password
        ? { body: { access_token: 'at-1', user: user() } }
        : {
            status: 400,
            body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
          }
      : undefined;

  describe('client request shapes', () => {
    it('sends the documented requests with apikey headers', async () => {
      const mock = createMockFetch((call) => {
        if (call.url.pathname === '/auth/v1/signup') return { body: user() };
        if (call.url.pathname === '/auth/v1/token')
          return { body: { access_token: 'tok', user: user() } };
        if (call.url.pathname === '/auth/v1/recover') return { body: {} };
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'tok2', user: user() } };
        if (call.url.pathname === '/auth/v1/user') return { body: user() };
        if (call.url.pathname === '/auth/v1/admin/users') return { body: user() };
        return undefined;
      });
      const client = new SupabaseAuthClient(
        { url: `${baseUrl}/`, anonKey, serviceRoleKey: 'sb_secret_x' },
        mock.fetchImpl,
      );

      await client.signUp(email, password, 'https://app.test/account/confirm');
      await client.signInWithPassword(email, password);
      await client.recover(email, 'https://app.test/account/confirm');
      await client.verify('recovery', 'hash123');
      await client.updateUser('user-token', { password: 'new-pass' });
      await client.adminCreateUser(email, password);

      const [signup, token, recover, verify, update, admin] = mock.calls;
      expect(signup?.url.toString()).toBe(
        `${baseUrl}/auth/v1/signup?redirect_to=${encodeURIComponent('https://app.test/account/confirm')}`,
      );
      expect(signup?.body).toEqual({ email, password });
      expect(signup?.headers.apikey).toBe(anonKey);
      expect(signup?.headers.authorization).toBeUndefined();
      expect(token?.url.search).toBe('?grant_type=password');
      expect(recover?.body).toEqual({ email });
      expect(verify?.body).toEqual({ type: 'recovery', token_hash: 'hash123' });
      expect(update?.method).toBe('PUT');
      expect(update?.headers.authorization).toBe('Bearer user-token');
      expect(update?.headers.apikey).toBe(anonKey);
      expect(update?.body).toEqual({ password: 'new-pass' });
      expect(admin?.headers.apikey).toBe('sb_secret_x');
      expect(admin?.body).toEqual({ email, password, email_confirm: true });
    });

    it('turns HTTP and network failures into SupabaseAuthError', async () => {
      const failing = new SupabaseAuthClient(
        { url: baseUrl, anonKey },
        createMockFetch(() => ({
          status: 400,
          body: { error_description: 'Email not confirmed' },
        })).fetchImpl,
      );
      await expect(failing.signInWithPassword(email, password)).rejects.toMatchObject({
        status: 400,
        code: 'email_not_confirmed',
      });

      const offline = new SupabaseAuthClient({ url: baseUrl, anonKey }, async () => {
        throw new Error('down');
      });
      await expect(offline.recover(email, 'x')).rejects.toBeInstanceOf(SupabaseAuthError);
      await expect(
        new SupabaseAuthClient({ url: baseUrl, anonKey }).adminCreateUser(email, password),
      ).rejects.toMatchObject({ code: 'service_key_missing' });
    });
  });

  describe('register and login', () => {
    it('responds 202 confirmation_sent when Supabase returns no session', async () => {
      const { plugin, calls } = setup((call) =>
        call.url.pathname === '/auth/v1/signup' ? { body: user() } : undefined,
      );
      const response = await anonymous(plugin, '/auth/register', { email, password });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'confirmation_sent' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(calls[0]?.url.searchParams.get('redirect_to')).toBe(`${origin}/account/confirm`);
      expect(plugin.repository.findUserByEmail(email)).toBeNull();
    });

    it('logs in immediately when Supabase returns a session', async () => {
      const { plugin } = setup((call) =>
        call.url.pathname === '/auth/v1/signup'
          ? { body: { access_token: 'at', user: user() } }
          : undefined,
      );
      const response = await anonymous(plugin, '/auth/register', { email, password });

      expect(response.status).toBe(201);
      expect(cookieValue(response, 'eac_session')).not.toBe('');
      const stored = plugin.repository.findUserByEmail(email);
      expect(stored).toMatchObject({
        authProvider: 'supabase',
        externalId: 'sb-user-1',
        passwordHash: '!external',
        role: 'student',
      });
    });

    it('upserts the user on password login and keeps the role', async () => {
      const { plugin } = setup(passwordGrant);
      const first = await anonymous(plugin, '/auth/login', { email, password });
      expect(first.status).toBe(200);
      plugin.database.prepare("UPDATE users SET role = 'instructor' WHERE email = ?").run(email);

      const second = await anonymous(plugin, '/auth/login', { email, password });
      expect(second.status).toBe(200);
      expect((second.body as { user: { role: string } }).user.role).toBe('instructor');
      expect(plugin.database.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
      expect(JSON.stringify(first.body)).not.toContain('at-1');
    });

    it('rejects wrong passwords and explains unconfirmed email', async () => {
      const { plugin } = setup((call) => {
        const body = call.body as { password?: string } | undefined;
        if (body?.password === 'unconfirmed') {
          return {
            status: 400,
            body: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' },
          };
        }
        return passwordGrant(call);
      });
      const wrong = await anonymous(plugin, '/auth/login', { email, password: 'nope' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ code: 'unauthorized', reason: 'invalid_credentials' });

      const unconfirmed = await anonymous(plugin, '/auth/login', {
        email,
        password: 'unconfirmed',
      });
      expect(unconfirmed.status).toBe(403);
      expect(unconfirmed.body).toMatchObject({ reason: 'email_not_confirmed' });
    });

    it('still signs local-provider users in offline while supabase is active', async () => {
      const { plugin, calls } = setup(() => undefined);
      await plugin.service.register({ email, password });
      const response = await anonymous(plugin, '/auth/login', { email, password });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(0);
      const wrong = await anonymous(plugin, '/auth/login', { email, password: 'bad' });
      expect(wrong.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  });

  describe('forgot password', () => {
    it('always answers 202, even when Supabase fails, and rate limits per client and email', async () => {
      let failing = true;
      const { plugin, calls } = setup((call) =>
        call.url.pathname === '/auth/v1/recover'
          ? failing
            ? { status: 500, body: { msg: 'boom' } }
            : { body: {} }
          : undefined,
      );

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await anonymous(plugin, '/auth/forgot-password', { email });
        expect(response.status).toBe(202);
        expect(response.body).toEqual({ status: 'confirmation_sent' });
        failing = false;
      }
      expect(calls.filter((call) => call.url.pathname === '/auth/v1/recover')).toHaveLength(3);

      const other = await anonymous(plugin, '/auth/forgot-password', { email: 'x@example.test' });
      expect(other.status).toBe(202);
      expect(calls.filter((call) => call.url.pathname === '/auth/v1/recover')).toHaveLength(4);
      // The per-email cap holds even when the request comes from a different client.
      const otherIp = await anonymous(plugin, '/auth/forgot-password', { email }, '10.9.9.9');
      expect(otherIp.status).toBe(202);
      expect(calls.filter((call) => call.url.pathname === '/auth/v1/recover')).toHaveLength(4);
    });

    it('requires a CSRF token', async () => {
      const { plugin } = setup(() => undefined);
      const response = await plugin.routes.handle({
        method: 'POST',
        path: '/auth/forgot-password',
        headers: { origin },
        body: { email },
      });
      expect(response.status).toBe(403);
    });
  });

  describe('confirm', () => {
    const verifyResponder =
      (userValue: object = user()): Responder =>
      (call) =>
        call.url.pathname === '/auth/v1/verify'
          ? { body: { access_token: 'verified-at', user: userValue } }
          : undefined;

    it.each(['email', 'invite', 'magiclink'])('type %s signs the user in', async (type) => {
      const { plugin, calls } = setup(verifyResponder());
      const response = await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'signed_in', user: { email } });
      expect(cookieValue(response, 'eac_session')).not.toBe('');
      expect(calls[0]?.body).toEqual({ type, token_hash: 'th' });
      expect(JSON.stringify(response.body)).not.toContain('verified-at');
      expect(plugin.repository.findUserByEmail(email)?.authProvider).toBe('supabase');
    });

    it('rejects unknown types and expired links', async () => {
      const { plugin } = setup((call) =>
        call.url.pathname === '/auth/v1/verify'
          ? { status: 403, body: { error_code: 'otp_expired', msg: 'expired' } }
          : undefined,
      );
      const bad = await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type: 'weird' });
      expect(bad.status).toBe(400);
      const expired = await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type: 'email' });
      expect(expired.status).toBe(400);
      expect(expired.body).toMatchObject({ reason: 'link_invalid' });
    });

    it('updates the local email on email_change', async () => {
      const { plugin } = setup((call) => {
        if (call.url.pathname === '/auth/v1/token')
          return { body: { access_token: 'at', user: user() } };
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'at2', user: user('sb-user-1', 'new@example.test') } };
        return undefined;
      });
      await anonymous(plugin, '/auth/login', { email, password });

      const response = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'email_change',
      });
      expect(response.body).toEqual({ status: 'email_changed' });
      expect(plugin.repository.findUserByEmail('new@example.test')).not.toBeNull();
      expect(plugin.repository.findUserByEmail(email)).toBeNull();
    });

    it('reports a still-pending secure email change', async () => {
      const { plugin } = setup(
        verifyResponder(user('sb-user-1', email, { new_email: 'n@e.test' })),
      );
      const response = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'email_change',
      });
      expect(response.body).toEqual({ status: 'email_change_pending' });
    });

    it('recovery issues a session and allows exactly one reset-password', async () => {
      const { plugin, calls } = setup((call) => {
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'recovery-at', user: user() } };
        if (call.url.pathname === '/auth/v1/user') return { body: user() };
        return undefined;
      });
      const confirmed = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'recovery',
      });
      expect(confirmed.body).toMatchObject({ status: 'reset_required' });
      const session = sessionOf(confirmed);

      const reset = await authed(plugin, session, '/auth/reset-password', {
        password: 'a brand new password',
      });
      expect(reset.status).toBe(200);
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.headers.authorization).toBe('Bearer recovery-at');
      expect(put?.body).toEqual({ password: 'a brand new password' });

      const again = await authed(plugin, session, '/auth/reset-password', {
        password: 'another one',
      });
      expect(again.status).toBe(403);
      expect(again.body).toMatchObject({ reason: 'recovery_expired' });
    });

    it('rejects reset-password without a pending recovery or after the 10 minute TTL', async () => {
      const clock = new MutableClock();
      const { plugin } = setup(
        (call) => {
          if (call.url.pathname === '/auth/v1/verify')
            return { body: { access_token: 'recovery-at', user: user() } };
          if (call.url.pathname === '/auth/v1/token')
            return { body: { access_token: 'at', user: user() } };
          return undefined;
        },
        {},
        clock,
      );

      const loggedIn = await anonymous(plugin, '/auth/login', { email, password });
      const plain = await authed(plugin, sessionOf(loggedIn), '/auth/reset-password', {
        password: 'whatever it is',
      });
      expect(plain.status).toBe(403);

      const anon = await anonymous(plugin, '/auth/reset-password', { password: 'x' });
      expect(anon.status).toBe(401);

      const recovery = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'recovery',
      });
      clock.advance(10 * 60 * 1000 + 1);
      const late = await authed(plugin, sessionOf(recovery), '/auth/reset-password', {
        password: 'too late',
      });
      // The abandoned recovery session is revoked once its entry expires.
      expect(late.status).toBe(401);
    });
  });

  describe('change password and email', () => {
    async function signedIn(responder: Responder) {
      const ctx = setup((call) => responder(call) ?? passwordGrant(call));
      const login = await anonymous(ctx.plugin, '/auth/login', { email, password });
      return { ...ctx, session: sessionOf(login) };
    }

    it('re-authenticates then updates the Supabase password', async () => {
      const { plugin, calls, session } = await signedIn((call) =>
        call.url.pathname === '/auth/v1/user' ? { body: user() } : undefined,
      );
      const response = await authed(plugin, session, '/auth/change-password', {
        currentPassword: password,
        newPassword: 'the new password',
      });

      expect(response.status).toBe(200);
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.headers.authorization).toBe('Bearer at-1');
      expect(put?.body).toEqual({ password: 'the new password' });
    });

    it('rejects a wrong current password without calling PUT', async () => {
      const { plugin, calls, session } = await signedIn(() => undefined);
      const response = await authed(plugin, session, '/auth/change-password', {
        currentPassword: 'wrong',
        newPassword: 'the new password',
      });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ reason: 'invalid_credentials' });
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('changes email with re-auth and answers 202', async () => {
      const { plugin, calls, session } = await signedIn((call) =>
        call.url.pathname === '/auth/v1/user'
          ? { body: user('sb-user-1', email, { new_email: 'n@e.test' }) }
          : undefined,
      );
      const response = await authed(plugin, session, '/auth/change-email', {
        newEmail: 'N@E.test',
        currentPassword: password,
      });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'confirmation_sent' });
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.body).toEqual({ email: 'n@e.test' });
      expect(put?.url.searchParams.get('redirect_to')).toBe(`${origin}/account/confirm`);
      expect(plugin.repository.findUserByEmail(email)).not.toBeNull();

      const wrong = await authed(plugin, session, '/auth/change-email', {
        newEmail: 'n@e.test',
        currentPassword: 'wrong',
      });
      expect(wrong.status).toBe(403);
    });
  });
});

describe('local provider', () => {
  const plugins: AuthPlugin[] = [];
  afterEach(() => {
    for (const plugin of plugins.splice(0)) {
      plugin.close();
    }
  });

  function localPlugin(): AuthPlugin {
    const plugin = createAuthPlugin(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        ALLOWED_ORIGINS: origin,
        COOKIE_SECURE: 'false',
      }),
      {
        fetchImpl: async () => {
          throw new Error('local mode must never call Supabase');
        },
      },
    );
    plugins.push(plugin);
    return plugin;
  }

  async function session(plugin: AuthPlugin) {
    const csrfResponse = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: {},
    });
    const token = (csrfResponse.body as { csrfToken: string }).csrfToken;
    const cookie = cookieValue(csrfResponse, 'eac_csrf');
    const registered = await plugin.routes.handle({
      method: 'POST',
      path: '/auth/register',
      headers: { origin, cookie: `eac_csrf=${encodeURIComponent(cookie)}`, 'x-csrf-token': token },
      body: { email, password },
    });
    return {
      sessionToken: cookieValue(registered, 'eac_session'),
      csrfToken: (registered.body as { csrfToken: string }).csrfToken,
      cookie,
      token,
    };
  }

  function post(
    plugin: AuthPlugin,
    s: Awaited<ReturnType<typeof session>>,
    path: string,
    body: unknown,
  ) {
    return plugin.routes.handle({
      method: 'POST',
      path,
      headers: {
        origin,
        cookie: `eac_session=${encodeURIComponent(s.sessionToken)}; eac_csrf=${encodeURIComponent(s.csrfToken)}`,
        'x-csrf-token': s.csrfToken,
      },
      body,
    });
  }

  it('rejects email features with a clear 501', async () => {
    const plugin = localPlugin();
    const s = await session(plugin);
    const anonHeaders = {
      origin,
      cookie: `eac_csrf=${encodeURIComponent(s.cookie)}`,
      'x-csrf-token': s.token,
    };

    for (const path of ['/auth/forgot-password', '/auth/confirm']) {
      const response = await plugin.routes.handle({
        method: 'POST',
        path,
        headers: anonHeaders,
        body: { email, token_hash: 'x', type: 'email' },
      });
      expect(response.status).toBe(501);
      expect(response.body).toMatchObject({ code: 'invalid_state', reason: 'supabase_required' });
    }
    for (const [path, body] of [
      ['/auth/reset-password', { password }],
      ['/auth/change-email', { newEmail: 'x@example.test', currentPassword: password }],
    ] as const) {
      const response = await post(plugin, s, path, body);
      expect(response.status).toBe(501);
    }
  });

  it('changes the local password after verifying the current one', async () => {
    const plugin = localPlugin();
    const s = await session(plugin);

    const wrong = await post(plugin, s, '/auth/change-password', {
      currentPassword: 'not it',
      newPassword: 'a different password',
    });
    expect(wrong.status).toBe(403);

    const ok = await post(plugin, s, '/auth/change-password', {
      currentPassword: password,
      newPassword: 'a different password',
    });
    expect(ok.status).toBe(200);
    await expect(
      plugin.service.login({ email, password: 'a different password' }),
    ).resolves.toMatchObject({ user: { email } });
    await expect(plugin.service.login({ email, password })).rejects.toThrow();
  });

  it('adds the identity columns with safe defaults', () => {
    const plugin = localPlugin();
    const columns = plugin.database.prepare("SELECT name FROM pragma_table_info('users')").all();
    expect(columns.map((row) => row.name)).toEqual(
      expect.arrayContaining(['auth_provider', 'external_id']),
    );
    plugin.database
      .prepare(
        "INSERT INTO users (id, email, password_hash, role, created_at, external_id) VALUES ('a','a@e.test','x','student','2026-01-01','ext')",
      )
      .run();
    expect(() =>
      plugin.database
        .prepare(
          "INSERT INTO users (id, email, password_hash, role, created_at, external_id) VALUES ('b','b@e.test','x','student','2026-01-01','ext')",
        )
        .run(),
    ).toThrow(/UNIQUE/u);
    expect(plugin.database.prepare("SELECT auth_provider FROM users WHERE id = 'a'").get()).toEqual(
      {
        auth_provider: 'local',
      },
    );
  });
});
