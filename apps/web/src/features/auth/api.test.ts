import { describe, expect, it } from 'vitest';

import { AuthApiError, createAuthApi, type FetchLike } from './api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('browser authentication API boundary', () => {
  it('fetches CSRF state before unsafe calls and sends credentials by cookie', async () => {
    const calls: Array<{
      readonly input: RequestInfo | URL;
      readonly init: RequestInit | undefined;
    }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.endsWith('/auth/csrf')) {
        return jsonResponse({ csrfToken: 'anonymous-csrf-token' });
      }

      if (url.endsWith('/auth/login')) {
        const headers = init?.headers as Record<string, string>;
        expect(init?.credentials).toBe('include');
        expect(headers['x-csrf-token']).toBe('anonymous-csrf-token');
        expect(JSON.parse(String(init?.body))).toEqual({
          email: 'student@example.test',
          password: 'correct horse battery staple',
        });
        return jsonResponse({
          user: { id: 'user-1', email: 'student@example.test', role: 'student' },
          csrfToken: 'session-csrf-token',
          expiresAt: '2026-09-15T01:00:00.000Z',
        });
      }

      if (url.endsWith('/auth/logout')) {
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-csrf-token']).toBe('session-csrf-token');
        return new Response(null, { status: 204 });
      }

      return jsonResponse({
        user: { id: 'user-1', email: 'student@example.test', role: 'student' },
      });
    };

    const api = createAuthApi('/api', fetchImpl);
    const session = await api.login({
      email: 'student@example.test',
      password: 'correct horse battery staple',
    });
    await api.logout();
    const user = await api.currentUser();

    expect(session.user.role).toBe('student');
    expect(user?.email).toBe('student@example.test');
    expect(calls).toHaveLength(4);
    expect(String(calls[0]?.input)).toBe('/api/auth/csrf');
    expect(String(calls[1]?.input)).toBe('/api/auth/login');
    expect(String(calls[2]?.input)).toBe('/api/auth/logout');
  });

  it('returns null for an unauthenticated current-user request', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ secret: 'not public' }, 401);
    const api = createAuthApi('', fetchImpl);

    await expect(api.currentUser()).resolves.toBeNull();
  });

  it('registers a student through the same CSRF-protected session boundary', async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith('/auth/csrf')) {
        return jsonResponse({ csrfToken: 'anonymous-csrf-token' });
      }
      return jsonResponse({
        user: { id: 'user-2', email: 'new@example.test', role: 'student' },
        csrfToken: 'session-csrf-token',
        expiresAt: '2026-09-15T01:00:00.000Z',
      });
    };
    const api = createAuthApi('', fetchImpl);

    await expect(
      api.register({ email: 'new@example.test', password: 'correct horse battery staple' }),
    ).resolves.toMatchObject({ user: { email: 'new@example.test', role: 'student' } });

    expect(String(calls[1]?.input)).toBe('/auth/register');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.body).toContain('new@example.test');
    expect((calls[1]?.init?.headers as Record<string, string>)['x-csrf-token']).toBe(
      'anonymous-csrf-token',
    );
  });

  it('does not expose arbitrary server error bodies', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ message: 'secret SQL statement and password' }, 500);
    const api = createAuthApi('', fetchImpl);

    await expect(api.currentUser()).rejects.toMatchObject({
      problem: {
        code: 'invalid_state',
        message: 'The request could not be completed.',
      },
    } satisfies Partial<AuthApiError>);
  });

  it('surfaces only whitelisted problem reasons and posts confirm links with CSRF', async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.endsWith('/auth/csrf')) {
        return jsonResponse({ csrfToken: 'anonymous-csrf-token' });
      }
      if (url.endsWith('/auth/confirm')) {
        return jsonResponse({ status: 'email_changed' });
      }
      return jsonResponse({ code: 'forbidden', message: 'x', reason: 'email_not_confirmed' }, 403);
    };
    const api = createAuthApi('', fetchImpl);

    await expect(api.confirm({ tokenHash: 'th', type: 'email_change' })).resolves.toEqual({
      status: 'email_changed',
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      token_hash: 'th',
      type: 'email_change',
    });
    await expect(
      api.changePassword({ currentPassword: 'a', newPassword: 'b' }),
    ).rejects.toMatchObject({ problem: { code: 'forbidden', reason: 'email_not_confirmed' } });
  });
});
