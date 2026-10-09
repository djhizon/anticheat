import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createAuthPlugin, type AuthPlugin, type AuthRequest } from './auth.plugin.js';
import { hashToken } from './session.js';
import { BrowserAuthApi, type FetchLike } from '../../../../web/src/features/auth/api.js';

const origin = 'http://localhost:5173';
const email = 'reload@example.test';
const password = 'correct horse battery staple';

function responseBody(
  response: Awaited<ReturnType<AuthPlugin['routes']['handle']>>,
): string | null {
  return response.body === null || response.status === 204 ? null : JSON.stringify(response.body);
}

function cookieParts(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

describe('browser authentication reload boundary', () => {
  let plugin!: AuthPlugin;

  beforeEach(() => {
    plugin = createAuthPlugin(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_PATH: ':memory:',
        ALLOWED_ORIGINS: origin,
        COOKIE_SECURE: 'false',
      }),
    );
  });

  afterEach(() => {
    plugin.close();
  });

  it('rotates a session CSRF token after a new BrowserAuthApi instance reloads', async () => {
    const cookies = new Map<string, string>();
    const fetchImpl: FetchLike = async (input, init) => {
      const requestHeaders = new Headers(init?.headers);
      const cookieHeader = [...cookies.entries()]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; ');
      const request: AuthRequest = {
        method: String(init?.method ?? 'GET'),
        path: new URL(String(input), 'http://localhost:5173').pathname.replace(/^\/api/u, ''),
        headers: {
          origin,
          accept: requestHeaders.get('accept') ?? undefined,
          'content-type': requestHeaders.get('content-type') ?? undefined,
          'x-csrf-token': requestHeaders.get('x-csrf-token') ?? undefined,
          cookie: cookieHeader === '' ? undefined : cookieHeader,
        },
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      const serverResponse = await plugin.routes.handle(request);

      for (const cookie of cookieParts(serverResponse.headers['set-cookie'])) {
        const [nameValue] = cookie.split(';', 1);
        const separator = nameValue?.indexOf('=') ?? -1;
        if (separator <= 0 || nameValue === undefined) {
          continue;
        }

        const name = nameValue.slice(0, separator);
        const value = decodeURIComponent(nameValue.slice(separator + 1));
        if (cookie.includes('Max-Age=0')) {
          cookies.delete(name);
        } else {
          cookies.set(name, value);
        }
      }

      return new Response(responseBody(serverResponse), {
        status: serverResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    };

    const firstPageApi = new BrowserAuthApi('/api', fetchImpl);
    await firstPageApi.register({ email, password });
    const sessionToken = cookies.get('eac_session');
    expect(sessionToken).toBeDefined();
    const beforeReloadHash = plugin.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(hashToken(sessionToken!))?.csrf_token_hash;

    const reloadedApi = new BrowserAuthApi('/api', fetchImpl);
    const refreshed = await reloadedApi.getCsrf();
    const afterReloadHash = plugin.database
      .prepare('SELECT csrf_token_hash FROM sessions WHERE token_hash = ?')
      .get(hashToken(sessionToken!))?.csrf_token_hash;
    expect(afterReloadHash).toBe(hashToken(refreshed.csrfToken));
    expect(afterReloadHash).not.toBe(beforeReloadHash);

    await expect(reloadedApi.logout()).resolves.toBeUndefined();
    expect(plugin.service.authenticateSession(sessionToken)).toBeNull();
  });
});
