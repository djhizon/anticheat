import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from './auth.plugin.js';
import { hashPassword, verifyPassword } from './password.js';
import { hashToken } from './session.js';

const origin = 'http://localhost:5173';
const email = 'student@example.test';
const password = 'correct horse battery staple';

interface CsrfContext {
  readonly token: string;
  readonly cookie: string;
}

function cookiesFromResponse(response: {
  headers: Readonly<Record<string, string | readonly string[]>>;
}): readonly string[] {
  const value = response.headers['set-cookie'];
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

function cookieFromResponse(
  response: { headers: Readonly<Record<string, string | readonly string[]>> },
  name: string,
): string {
  const cookie = cookiesFromResponse(response).find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie.`);
  }

  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
}

async function issueCsrf(plugin: AuthPlugin): Promise<CsrfContext> {
  const response = await plugin.routes.handle({ method: 'GET', path: '/auth/csrf', headers: {} });
  expect(response.status).toBe(200);

  const body = response.body as { csrfToken: string };
  return {
    token: body.csrfToken,
    cookie: cookieFromResponse(response, 'eac_csrf'),
  };
}

function anonymousRequest(csrf: CsrfContext, body: unknown): AuthRequest {
  return {
    method: 'POST',
    path: '/auth/register',
    headers: {
      origin,
      cookie: `eac_csrf=${encodeURIComponent(csrf.cookie)}`,
      'x-csrf-token': csrf.token,
    },
    body,
  };
}

async function register(plugin: AuthPlugin): Promise<{
  readonly response: Awaited<ReturnType<AuthPlugin['routes']['handle']>>;
  readonly sessionToken: string;
  readonly csrfToken: string;
}> {
  const csrf = await issueCsrf(plugin);
  const response = await plugin.routes.handle(anonymousRequest(csrf, { email, password }));
  const body = response.body as { csrfToken: string };

  return {
    response,
    sessionToken: cookieFromResponse(response, 'eac_session'),
    csrfToken: body.csrfToken,
  };
}

function createPlugin(): AuthPlugin {
  return createAuthPlugin(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      ALLOWED_ORIGINS: origin,
      COOKIE_SECURE: 'false',
      SESSION_TTL_SECONDS: '3600',
    }),
  );
}

describe('authentication boundary', () => {
  let plugin!: AuthPlugin;

  beforeEach(() => {
    plugin = createPlugin();
  });

  afterEach(() => {
    plugin.close();
  });

  it('hashes and verifies passwords with Argon2id', async () => {
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(/^\$argon2id\$v=19\$/u);
    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', encoded)).resolves.toBe(false);
  });

  it('runs every migration, including integrity and phone presence tables', () => {
    const rows = plugin.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();

    expect(rows.map((row) => row.name)).toEqual([
      'answer_revisions',
      'app_events',
      'attempt_answers',
      'attempt_mutations',
      'attempt_setup',
      'audio_sessions',
      'audio_transcripts',
      'audit_events',
      'evidence_snapshots',
      'exam_assignments',
      'exam_attempts',
      'exam_version_questions',
      'exam_versions',
      'exams',
      'gaze_events',
      'input_behaviour_windows',
      'keystroke_events',
      'liveness_challenges',
      'liveness_events',
      'phone_enrollments',
      'phone_presence',
      'question_versions',
      'schema_migrations',
      'sessions',
      'users',
      'voice_events',
    ]);
  });

  it('returns explicit credentialed CORS headers for allowed GET and POST requests', async () => {
    const csrfResponse = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { origin },
    });
    expect(csrfResponse.status).toBe(200);
    expect(csrfResponse.headers['access-control-allow-origin']).toBe(origin);
    expect(csrfResponse.headers['access-control-allow-credentials']).toBe('true');
    expect(csrfResponse.headers.vary).toBe('Origin');

    const csrf = {
      token: (csrfResponse.body as { csrfToken: string }).csrfToken,
      cookie: cookieFromResponse(csrfResponse, 'eac_csrf'),
    };
    const registered = await plugin.routes.handle(anonymousRequest(csrf, { email, password }));
    expect(registered.status).toBe(201);
    expect(registered.headers['access-control-allow-origin']).toBe(origin);
    expect(registered.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not rotate an active session on an Origin-less CSRF bootstrap request', async () => {
    const registered = await register(plugin);
    const sessionHash = hashToken(registered.sessionToken);
    const before = plugin.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(sessionHash)?.csrf_token_hash;

    const response = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });

    expect(response.status).toBe(200);
    const after = plugin.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(sessionHash)?.csrf_token_hash;
    expect(after).toBe(before);

    const logout = await plugin.routes.handle({
      method: 'POST',
      path: '/auth/logout',
      headers: {
        origin,
        cookie: `eac_session=${registered.sessionToken}; eac_csrf=${registered.csrfToken}`,
        'x-csrf-token': registered.csrfToken,
      },
    });
    expect(logout.status).toBe(204);
  });

  it('answers an allowed auth preflight with explicit methods and headers', async () => {
    const response = await plugin.routes.handle({
      method: 'OPTIONS',
      path: '/auth/login',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-csrf-token',
      },
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe(
      'Content-Type, X-CSRF-Token, X-Requested-With',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers.vary).toBe('Origin');
  });

  it('rejects a disallowed origin without credentialed CORS permission', async () => {
    const response = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { origin: 'https://attacker.example' },
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toBe('Origin');
    expect(response.body).toEqual({
      code: 'forbidden',
      message: 'You do not have permission to perform this action.',
    });
  });

  it('does not rotate the CSRF hash for invalid, expired, or revoked sessions', async () => {
    const registered = await register(plugin);
    const sessionHash = hashToken(registered.sessionToken);
    const readCsrfHash = (): unknown =>
      plugin.database
        .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
        .get(sessionHash)?.csrf_token_hash;
    const initialHash = readCsrfHash();

    const invalid = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { cookie: 'eac_session=invalid-session-token' },
    });
    expect(invalid.status).toBe(200);
    expect(readCsrfHash()).toBe(initialHash);

    plugin.database
      .prepare('UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?')
      .run('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:01.000Z', sessionHash);
    const expired = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });
    expect(expired.status).toBe(200);
    const expiredHash = readCsrfHash();

    plugin.database
      .prepare('UPDATE sessions SET expires_at = ?, revoked_at = ? WHERE token_hash = ?')
      .run('2099-01-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z', sessionHash);
    const revoked = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/csrf',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });
    expect(revoked.status).toBe(200);
    expect(readCsrfHash()).toBe(expiredHash);
  });

  it('registers, reads, and revokes a session without storing raw tokens', async () => {
    const registered = await register(plugin);
    expect(registered.response.status).toBe(201);

    const sessionRows = plugin.database
      .prepare('SELECT token_hash, csrf_token_hash FROM sessions')
      .all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.token_hash).not.toBe(registered.sessionToken);
    expect(sessionRows[0]?.csrf_token_hash).not.toBe(registered.csrfToken);
    expect(String(sessionRows[0]?.token_hash)).toMatch(/^[0-9a-f]{64}$/u);

    const currentUser = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });
    expect(currentUser.status).toBe(200);
    expect(currentUser.body).toMatchObject({ user: { email, role: 'student' } });

    const logout = await plugin.routes.handle({
      method: 'POST',
      path: '/auth/logout',
      headers: {
        origin,
        cookie: `eac_session=${registered.sessionToken}; eac_csrf=${registered.csrfToken}`,
        'x-csrf-token': registered.csrfToken,
      },
    });
    expect(logout.status).toBe(204);

    const afterLogout = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });
    expect(afterLogout.status).toBe(401);
  });

  it('rotates and revokes the previous session on login', async () => {
    const registered = await register(plugin);
    const csrf = await issueCsrf(plugin);
    const login = await plugin.routes.handle({
      method: 'POST',
      path: '/auth/login',
      headers: {
        origin,
        cookie: `eac_session=${registered.sessionToken}; eac_csrf=${csrf.cookie}`,
        'x-csrf-token': csrf.token,
      },
      body: { email, password },
    });
    const nextSessionToken = cookieFromResponse(login, 'eac_session');

    expect(login.status).toBe(200);
    expect(nextSessionToken).not.toBe(registered.sessionToken);

    const oldSession = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { cookie: `eac_session=${registered.sessionToken}` },
    });
    const newSession = await plugin.routes.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { cookie: `eac_session=${nextSessionToken}` },
    });
    expect(oldSession.status).toBe(401);
    expect(newSession.status).toBe(200);

    const revoked = plugin.database
      .prepare('SELECT revoked_at FROM sessions WHERE token_hash = ?')
      .get(hashToken(registered.sessionToken));
    expect(revoked).toBeDefined();
    expect(revoked?.revoked_at).not.toBeNull();
  });

  it('rejects missing, invalid, and cross-origin unsafe requests', async () => {
    const csrf = await issueCsrf(plugin);
    const base = anonymousRequest(csrf, { email, password });

    const missingOrigin = await plugin.routes.handle({
      ...base,
      headers: { cookie: base.headers.cookie, 'x-csrf-token': csrf.token },
    });
    const missingCsrf = await plugin.routes.handle({
      ...base,
      headers: { origin, cookie: base.headers.cookie },
    });
    const wrongOrigin = await plugin.routes.handle({
      ...base,
      headers: { ...base.headers, origin: 'https://attacker.example' },
    });

    expect(missingOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(missingOrigin.body).toEqual({
      code: 'forbidden',
      message: 'You do not have permission to perform this action.',
    });
  });

  it('denies a student principal when an instructor role is required', async () => {
    const registered = await register(plugin);
    const principal = plugin.service.authenticateSession(registered.sessionToken);

    expect(principal).not.toBeNull();
    expect(() => plugin.boundary.requireRole(principal!, 'instructor')).toThrowError(
      'The current role is not allowed for this operation.',
    );
    expect(plugin.service.authenticateSession('invalid-token')).toBeNull();
  });

  it('redacts credential and database details from public errors', async () => {
    const csrf = await issueCsrf(plugin);
    const response = await plugin.routes.handle({
      method: 'POST',
      path: '/auth/login',
      headers: {
        origin,
        cookie: `eac_csrf=${csrf.cookie}`,
        'x-csrf-token': csrf.token,
      },
      body: { email, password: 'wrong password' },
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: 'unauthorized',
      message: 'Authentication is required.',
    });
    expect(JSON.stringify(response.body)).not.toContain('wrong password');
  });
});
