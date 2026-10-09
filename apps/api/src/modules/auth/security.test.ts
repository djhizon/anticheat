import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '@examguard/contracts';

import { loadConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin } from './auth.plugin.js';
import { ensureDemoAccount, isDemoEmail } from './demoAccounts.js';
import { AttemptLimiter } from './recoveryStore.js';
import { SupabaseAuthClient, SupabaseAuthError } from './supabaseAuth.js';

const origin = 'http://localhost:5173';
const baseUrl = 'https://proj.supabase.co';
const email = 'student@example.test';
const password = 'correct horse battery staple';

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
  readonly signal: AbortSignal | null | undefined;
}

type Responder = (call: Call) => { status?: number; body?: unknown } | undefined;

function createMockFetch(responder: Responder) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      signal: init?.signal,
    };
    calls.push(call);
    const result = responder(call) ?? { status: 500, body: { msg: 'unexpected' } };
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const user = (id = 'sb-user-1', userEmail = email) => ({ id, email: userEmail });

class MutableClock implements Clock {
  constructor(private current = new Date('2026-10-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
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

const passwordGrant: Responder = (call) =>
  call.url.pathname === '/auth/v1/token'
    ? call.body?.password === password
      ? { body: { access_token: 'at-1', user: user() } }
      : {
          status: 400,
          body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
        }
    : undefined;

describe('auth security hardening', () => {
  const plugins: AuthPlugin[] = [];
  afterEach(() => {
    for (const plugin of plugins.splice(0)) {
      plugin.close();
    }
  });

  function setup(responder: Responder, supabase = true, clock?: Clock) {
    const mock = createMockFetch(responder);
    const plugin = createAuthPlugin(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        ALLOWED_ORIGINS: origin,
        COOKIE_SECURE: 'false',
        ...(supabase ? { SUPABASE_URL: baseUrl, SUPABASE_ANON_KEY: 'sb_publishable_test' } : {}),
      }),
      { fetchImpl: mock.fetchImpl, ...(clock === undefined ? {} : { clock }) },
    );
    plugins.push(plugin);
    return { plugin, ...mock };
  }

  async function anonymous(plugin: AuthPlugin, path: string, body: unknown, ip = '10.0.0.1') {
    const csrf = await plugin.routes.handle({ method: 'GET', path: '/auth/csrf', headers: {} });
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    return plugin.routes.handle({
      method: 'POST',
      path,
      remoteAddress: ip,
      headers: {
        origin,
        cookie: `eac_csrf=${encodeURIComponent(cookieValue(csrf, 'eac_csrf'))}`,
        'x-csrf-token': token,
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

  function authed(
    plugin: AuthPlugin,
    session: { sessionToken: string; csrfToken: string },
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    csrfToken: string | null = session.csrfToken,
  ) {
    return plugin.routes.handle({
      method,
      path,
      headers: {
        origin,
        cookie: `eac_session=${encodeURIComponent(session.sessionToken)}`,
        ...(csrfToken === null ? {} : { 'x-csrf-token': csrfToken }),
      },
      body,
    });
  }

  function sessionCount(plugin: AuthPlugin, activeOnly = true): number {
    const row = plugin.database
      .prepare(`SELECT count(*) AS n FROM sessions ${activeOnly ? 'WHERE revoked_at IS NULL' : ''}`)
      .get() as { n: number };
    return row.n;
  }

  const loginResponder: Responder = (call) => {
    if (call.url.pathname === '/auth/v1/user') return { body: user() };
    return passwordGrant(call);
  };

  describe('session revocation', () => {
    it('repository revokes all sessions except the kept one', async () => {
      const { plugin } = setup(() => undefined, false);
      const a = await plugin.service.register({ email, password });
      await plugin.service.login({ email, password });
      await plugin.service.login({ email, password });
      const principal = plugin.service.authenticateSession(a.sessionToken);
      expect(principal).not.toBeNull();
      if (principal === null) return;

      expect(
        plugin.repository.revokeAllSessionsForUser(
          principal.user.id,
          principal.session.sessionId,
          new Date(Date.now() + 1000).toISOString(),
        ),
      ).toBe(2);
      expect(plugin.service.authenticateSession(a.sessionToken)).not.toBeNull();
      expect(
        plugin.repository.revokeAllSessionsForUser(
          principal.user.id,
          undefined,
          new Date(Date.now() + 1000).toISOString(),
        ),
      ).toBe(1);
      expect(plugin.service.authenticateSession(a.sessionToken)).toBeNull();
    });

    it('change-password (local) keeps the current session and revokes the others', async () => {
      const { plugin } = setup(() => undefined, false);
      const first = await plugin.service.register({ email, password });
      const other = await plugin.service.login({ email, password });
      const session = { sessionToken: first.sessionToken, csrfToken: first.csrfToken };

      const response = await authed(plugin, session, 'POST', '/auth/change-password', {
        currentPassword: password,
        newPassword: 'a much newer password',
      });
      expect(response.status).toBe(200);
      expect(plugin.service.authenticateSession(first.sessionToken)).not.toBeNull();
      expect(plugin.service.authenticateSession(other.sessionToken)).toBeNull();
    });

    it('change-password (supabase) keeps the current session and revokes the others', async () => {
      const { plugin } = setup(loginResponder);
      const a = await anonymous(plugin, '/auth/login', { email, password });
      const b = await anonymous(plugin, '/auth/login', { email, password });
      const response = await authed(plugin, sessionOf(a), 'POST', '/auth/change-password', {
        currentPassword: password,
        newPassword: 'a much newer password',
      });
      expect(response.status).toBe(200);
      expect(plugin.service.authenticateSession(sessionOf(a).sessionToken)).not.toBeNull();
      expect(plugin.service.authenticateSession(sessionOf(b).sessionToken)).toBeNull();
    });

    it('reset-password revokes the account sessions other than the recovery session', async () => {
      const { plugin } = setup((call) => {
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'recovery-at', user: user() } };
        return loginResponder(call);
      });
      const old = await anonymous(plugin, '/auth/login', { email, password });
      const recovery = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'recovery',
      });
      const reset = await authed(plugin, sessionOf(recovery), 'POST', '/auth/reset-password', {
        password: 'a brand new password',
      });
      expect(reset.status).toBe(200);
      expect(plugin.service.authenticateSession(sessionOf(old).sessionToken)).toBeNull();
      const after = plugin.service.authenticateSession(sessionOf(recovery).sessionToken);
      expect(after).not.toBeNull();
      expect(after?.resetRequired).toBe(false);
    });

    it('a confirmed email change revokes every session of that user', async () => {
      const { plugin } = setup((call) => {
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'at2', user: user('sb-user-1', 'new@example.test') } };
        return loginResponder(call);
      });
      const login = await anonymous(plugin, '/auth/login', { email, password });
      expect(sessionCount(plugin)).toBe(1);
      const confirmed = await anonymous(plugin, '/auth/confirm', {
        token_hash: 'th',
        type: 'email_change',
      });
      expect(confirmed.body).toEqual({ status: 'email_changed' });
      expect(plugin.service.authenticateSession(sessionOf(login).sessionToken)).toBeNull();
      expect(sessionCount(plugin)).toBe(0);
    });
  });

  describe('email sending abuse limits', () => {
    it('caps forgot-password per email across clients and stays 202', async () => {
      const { plugin, calls } = setup(() => ({ body: {} }));
      for (let i = 0; i < 6; i += 1) {
        const response = await anonymous(plugin, '/auth/forgot-password', { email }, `10.0.0.${i}`);
        expect(response.status).toBe(202);
      }
      expect(calls.filter((c) => c.url.pathname === '/auth/v1/recover')).toHaveLength(3);
    });

    it('caps forgot-password globally', async () => {
      const { plugin, calls } = setup(() => ({ body: {} }));
      for (let i = 0; i < 35; i += 1) {
        const response = await anonymous(
          plugin,
          '/auth/forgot-password',
          { email: `user${i}@example.test` },
          `10.0.1.${i}`,
        );
        expect(response.status).toBe(202);
      }
      expect(calls.filter((c) => c.url.pathname === '/auth/v1/recover')).toHaveLength(30);
    });

    it('caps register per email and globally with the same generic 202', async () => {
      const { plugin, calls } = setup((call) =>
        call.url.pathname === '/auth/v1/signup' ? { body: user() } : undefined,
      );
      for (let i = 0; i < 5; i += 1) {
        const response = await anonymous(
          plugin,
          '/auth/register',
          { email, password },
          `10.1.0.${i}`,
        );
        expect(response.status).toBe(202);
        expect(response.body).toEqual({ status: 'confirmation_sent' });
      }
      expect(calls.filter((c) => c.url.pathname === '/auth/v1/signup')).toHaveLength(3);

      for (let i = 0; i < 40; i += 1) {
        const response = await anonymous(
          plugin,
          '/auth/register',
          { email: `n${i}@example.test`, password },
          `10.2.0.${i}`,
        );
        expect(response.status).toBe(202);
      }
      expect(calls.filter((c) => c.url.pathname === '/auth/v1/signup')).toHaveLength(30);
    });
  });

  describe('register enumeration', () => {
    it('answers identically for new, existing supabase and existing local emails', async () => {
      const { plugin, calls } = setup((call) => {
        if (call.url.pathname !== '/auth/v1/signup') return undefined;
        return call.body?.email === 'taken@example.test'
          ? { status: 422, body: { error_code: 'user_already_exists', msg: 'exists' } }
          : { body: user('sb-new', String(call.body?.email)) };
      });
      await plugin.service.register({ email: 'local@example.test', password });
      const outcomes = [];
      for (const [i, candidate] of [
        'fresh@example.test',
        'taken@example.test',
        'local@example.test',
      ].entries()) {
        const response = await anonymous(
          plugin,
          '/auth/register',
          { email: candidate, password },
          `10.3.0.${i}`,
        );
        outcomes.push([response.status, response.body, response.headers['set-cookie']]);
      }
      expect(outcomes[0]).toEqual([202, { status: 'confirmation_sent' }, undefined]);
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[2]).toEqual(outcomes[0]);
      // Supabase is never asked about an address that already has a local account.
      expect(calls.map((c) => c.body?.email)).toEqual(['fresh@example.test', 'taken@example.test']);
    });

    it('keeps the local provider conflict behaviour', async () => {
      const { plugin } = setup(() => undefined, false);
      await plugin.service.register({ email, password });
      const response = await anonymous(plugin, '/auth/register', { email, password });
      expect(response.status).toBe(409);
    });
  });

  describe('password guess throttling', () => {
    it('locks supabase login per email after 5 failures and a success resets', async () => {
      const { plugin, calls } = setup(passwordGrant);
      for (let i = 0; i < 4; i += 1) {
        const bad = await anonymous(plugin, '/auth/login', { email, password: 'bad' });
        expect(bad.status).toBe(401);
      }
      const good = await anonymous(plugin, '/auth/login', { email, password });
      expect(good.status).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        await anonymous(plugin, '/auth/login', { email, password: 'bad' });
      }
      const before = calls.length;
      const limited = await anonymous(plugin, '/auth/login', { email, password });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ reason: 'rate_limited' });
      expect(calls).toHaveLength(before);
    });

    it('locks local login per email and recovers after the window', async () => {
      const clock = new MutableClock();
      const { plugin } = setup(() => undefined, false, clock);
      await plugin.service.register({ email, password });
      for (let i = 0; i < 5; i += 1) {
        const bad = await anonymous(plugin, '/auth/login', { email, password: 'bad' });
        expect(bad.status).toBe(401);
      }
      expect((await anonymous(plugin, '/auth/login', { email, password })).status).toBe(429);
      clock.advance(15 * 60 * 1000 + 1);
      expect((await anonymous(plugin, '/auth/login', { email, password })).status).toBe(200);
    });

    it('throttles current-password checks on change-password and change-email', async () => {
      const { plugin, calls } = setup(loginResponder);
      const session = sessionOf(await anonymous(plugin, '/auth/login', { email, password }));
      for (let i = 0; i < 3; i += 1) {
        const bad = await authed(plugin, session, 'POST', '/auth/change-password', {
          currentPassword: 'wrong',
          newPassword: 'whatever new',
        });
        expect(bad.status).toBe(403);
      }
      for (let i = 0; i < 2; i += 1) {
        const bad = await authed(plugin, session, 'POST', '/auth/change-email', {
          newEmail: 'n@example.test',
          currentPassword: 'wrong',
        });
        expect(bad.status).toBe(403);
      }
      const before = calls.length;
      for (const [path, body] of [
        ['/auth/change-password', { currentPassword: password, newPassword: 'whatever new' }],
        ['/auth/change-email', { newEmail: 'n@example.test', currentPassword: password }],
      ] as const) {
        const limited = await authed(plugin, session, 'POST', path, body);
        expect(limited.status).toBe(429);
        expect(limited.body).toMatchObject({ reason: 'rate_limited' });
      }
      expect(calls).toHaveLength(before);
    });

    it('throttles local change-password and resets on success', async () => {
      const { plugin } = setup(() => undefined, false);
      const registered = await plugin.service.register({ email, password });
      const session = { sessionToken: registered.sessionToken, csrfToken: registered.csrfToken };
      for (let i = 0; i < 4; i += 1) {
        await authed(plugin, session, 'POST', '/auth/change-password', {
          currentPassword: 'wrong',
          newPassword: 'x new password',
        });
      }
      const ok = await authed(plugin, session, 'POST', '/auth/change-password', {
        currentPassword: password,
        newPassword: 'x new password',
      });
      expect(ok.status).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        await authed(plugin, session, 'POST', '/auth/change-password', {
          currentPassword: 'wrong',
          newPassword: 'y new password',
        });
      }
      const limited = await authed(plugin, session, 'POST', '/auth/change-password', {
        currentPassword: 'x new password',
        newPassword: 'y new password',
      });
      expect(limited.status).toBe(429);
    });
  });

  describe('change-email collision', () => {
    it('rejects an address that already exists locally without sending the update', async () => {
      const { plugin, calls } = setup(loginResponder);
      await plugin.service.register({ email: 'other@example.test', password });
      const session = sessionOf(await anonymous(plugin, '/auth/login', { email, password }));
      const response = await authed(plugin, session, 'POST', '/auth/change-email', {
        newEmail: 'OTHER@example.test',
        currentPassword: password,
      });
      expect(response.status).toBe(409);
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  });

  describe('recovery sessions are reset-only', () => {
    const recoveryResponder: Responder = (call) => {
      if (call.url.pathname === '/auth/v1/verify')
        return { body: { access_token: 'recovery-at', user: user() } };
      if (call.url.pathname === '/auth/v1/user') return { body: user() };
      return passwordGrant(call);
    };

    it('rejects other authenticated routes with reset_required but allows me/reset/logout', async () => {
      const { plugin } = setup(recoveryResponder);
      const recovery = sessionOf(
        await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type: 'recovery' }),
      );

      const me = await authed(plugin, recovery, 'GET', '/auth/me');
      expect(me.status).toBe(200);

      for (const [path, body] of [
        ['/auth/change-password', { currentPassword: password, newPassword: 'a new one' }],
        ['/auth/change-email', { newEmail: 'n@example.test', currentPassword: password }],
      ] as const) {
        const blocked = await authed(plugin, recovery, 'POST', path, body);
        expect(blocked.status).toBe(403);
        expect(blocked.body).toMatchObject({ reason: 'reset_required' });
      }
      expect(() =>
        plugin.boundary.requirePrincipal({
          method: 'GET',
          path: '/exam/anything',
          headers: { cookie: `eac_session=${encodeURIComponent(recovery.sessionToken)}` },
        }),
      ).toThrow(/Finish resetting/u);

      const logout = await authed(plugin, recovery, 'POST', '/auth/logout');
      expect(logout.status).toBe(204);
    });

    it('revokes an abandoned recovery session once the entry expires', async () => {
      const clock = new MutableClock();
      const { plugin } = setup(recoveryResponder, true, clock);
      const recovery = sessionOf(
        await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type: 'recovery' }),
      );
      expect((await authed(plugin, recovery, 'GET', '/auth/me')).status).toBe(200);

      clock.advance(10 * 60 * 1000 + 1);
      expect((await authed(plugin, recovery, 'GET', '/auth/me')).status).toBe(401);
      expect(plugin.service.authenticateSession(recovery.sessionToken)).toBeNull();
      expect(sessionCount(plugin)).toBe(0);
    });
  });

  describe('Supabase request timeout', () => {
    it('sets an abort signal on every request', async () => {
      const mock = createMockFetch(() => ({ body: { access_token: 't', user: user() } }));
      const client = new SupabaseAuthClient({ url: baseUrl, anonKey: 'k' }, mock.fetchImpl);
      await client.signInWithPassword(email, password);
      await client.recover(email, 'https://app.test');
      expect(mock.calls).toHaveLength(2);
      for (const call of mock.calls) {
        expect(call.signal).toBeInstanceOf(AbortSignal);
        expect(call.signal?.aborted).toBe(false);
      }
    });

    it('maps a timeout to a generic unavailable error', async () => {
      const hanging = (_input: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      const client = new SupabaseAuthClient({ url: baseUrl, anonKey: 'k' }, hanging, 20);
      await expect(client.signInWithPassword(email, password)).rejects.toMatchObject({
        code: 'timeout',
        status: 0,
      });
      await expect(client.signInWithPassword(email, password)).rejects.toBeInstanceOf(
        SupabaseAuthError,
      );

      const { plugin } = setup(() => {
        throw new DOMException('timed out', 'TimeoutError');
      });
      const response = await anonymous(plugin, '/auth/login', { email, password });
      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({ reason: 'provider_unavailable' });
    });
  });

  describe('limiter memory bound', () => {
    it('evicts the oldest key when full and nothing has expired', () => {
      const limiter = new AttemptLimiter(1, 1000, 2);
      limiter.take('a', 0);
      limiter.take('b', 1);
      expect(limiter.size).toBe(2);
      limiter.take('c', 2);
      expect(limiter.size).toBe(2);
      // "a" was evicted, so it starts a fresh window instead of being limited.
      expect(limiter.take('a', 3)).toBe(true);
      expect(limiter.size).toBe(2);
    });

    it('prefers dropping expired keys and supports isLimited/reset', () => {
      const limiter = new AttemptLimiter(2, 1000, 2);
      limiter.take('a', 0);
      limiter.take('b', 900);
      limiter.take('c', 1500);
      expect(limiter.size).toBe(2);
      expect(limiter.take('b', 1600)).toBe(true);
      limiter.take('b', 1601);
      expect(limiter.isLimited('b', 1602)).toBe(true);
      expect(limiter.isLimited('b', 5000)).toBe(false);
      limiter.reset('b');
      expect(limiter.isLimited('b', 1602)).toBe(false);
    });
  });

  describe('CSRF negative tests', () => {
    it.each([
      ['/auth/logout', {}],
      ['/auth/change-password', { currentPassword: password, newPassword: 'another one' }],
      ['/auth/change-email', { newEmail: 'n@example.test', currentPassword: password }],
      ['/auth/reset-password', { password: 'a brand new password' }],
    ] as const)('%s rejects missing and wrong CSRF tokens', async (path, body) => {
      const { plugin, calls } = setup((call) => {
        if (call.url.pathname === '/auth/v1/verify')
          return { body: { access_token: 'recovery-at', user: user() } };
        return loginResponder(call);
      });
      const session =
        path === '/auth/reset-password'
          ? sessionOf(
              await anonymous(plugin, '/auth/confirm', { token_hash: 'th', type: 'recovery' }),
            )
          : sessionOf(await anonymous(plugin, '/auth/login', { email, password }));
      const before = calls.length;

      for (const csrf of [null, 'not-the-token']) {
        const response = await authed(plugin, session, 'POST', path, body, csrf);
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ code: 'forbidden' });
      }
      expect(calls).toHaveLength(before);
      expect(plugin.service.authenticateSession(session.sessionToken)).not.toBeNull();
    });
  });
});

describe('demo seed safety', () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  function ctx(responder: Responder, withAdmin = true) {
    const mock = createMockFetch(responder);
    const plugin = createAuthPlugin(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        COOKIE_SECURE: 'false',
        SUPABASE_URL: baseUrl,
        SUPABASE_ANON_KEY: 'sb_publishable_test',
      }),
      { fetchImpl: mock.fetchImpl },
    );
    const admin = withAdmin
      ? new SupabaseAuthClient(
          { url: baseUrl, anonKey: 'sb_publishable_test', serviceRoleKey: 'sb_secret_test' },
          mock.fetchImpl,
        )
      : undefined;
    return { plugin, admin, ...mock };
  }

  afterEach(() => {
    warnings.length = 0;
  });

  const existsResponder =
    (existing: { id: string; email: string }): Responder =>
    (call) => {
      if (call.method === 'POST' && call.url.pathname === '/auth/v1/admin/users')
        return { status: 422, body: { error_code: 'email_exists' } };
      if (call.method === 'GET' && call.url.pathname === '/auth/v1/admin/users')
        return { body: { users: [existing] } };
      if (call.method === 'PUT') return { body: existing };
      return undefined;
    };

  it('only treats @example.test as a demo address', () => {
    expect(isDemoEmail('Demo@EXAMPLE.test')).toBe(true);
    expect(isDemoEmail('boss@school.edu')).toBe(false);
    expect(isDemoEmail('x@example.test.evil.com')).toBe(false);
  });

  it('never overwrites the password of an existing non-demo Supabase user', async () => {
    const { plugin, admin, calls } = ctx(
      existsResponder({ id: 'real-1', email: 'real@school.edu' }),
    );
    const created = await ensureDemoAccount(
      { repository: plugin.repository, service: plugin.service, admin, warn },
      'real@school.edu',
      'seed-password',
    );
    plugin.close();
    expect(created).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(warnings[0]).toContain('real@school.edu');
  });

  it('updates the password of an existing @example.test user', async () => {
    const { plugin, admin, calls } = ctx(
      existsResponder({ id: 'demo-1', email: 'demo@example.test' }),
    );
    const created = await ensureDemoAccount(
      { repository: plugin.repository, service: plugin.service, admin, warn },
      'demo@example.test',
      'seed-password',
    );
    const stored = plugin.repository.findUserByEmail('demo@example.test');
    plugin.close();
    expect(created).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(stored).toMatchObject({ authProvider: 'supabase', externalId: 'demo-1' });
  });

  it('never adopts a non-demo local account and skips without calling Supabase', async () => {
    const { plugin, admin, calls } = ctx(() => ({ body: user('x', 'real@school.edu') }));
    await plugin.service.register({ email: 'real@school.edu', password });
    const created = await ensureDemoAccount(
      { repository: plugin.repository, service: plugin.service, admin, warn },
      'real@school.edu',
      'seed-password',
    );
    const stored = plugin.repository.findUserByEmail('real@school.edu');
    plugin.close();
    expect(created).toBe(false);
    expect(calls).toHaveLength(0);
    expect(stored?.authProvider).toBe('local');
    expect(warnings).toHaveLength(1);
  });

  it('adopts an existing @example.test local account', async () => {
    const { plugin, admin } = ctx((call) =>
      call.method === 'POST' && call.url.pathname === '/auth/v1/admin/users'
        ? { body: user('sb-demo', 'demo@example.test') }
        : undefined,
    );
    await plugin.service.register({ email: 'demo@example.test', password });
    await ensureDemoAccount(
      { repository: plugin.repository, service: plugin.service, admin, warn },
      'demo@example.test',
      'seed-password',
    );
    const stored = plugin.repository.findUserByEmail('demo@example.test');
    plugin.close();
    expect(stored).toMatchObject({ authProvider: 'supabase', externalId: 'sb-demo' });
  });
});
