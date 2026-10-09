// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { AuthApi } from './api.js';
import { AuthProvider, useAuth, type AuthContextValue } from './AuthProvider.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('shares one CSRF fetch between concurrent callers and reuses it (each fetch rotates the token)', async () => {
  let n = 0;
  const getCsrf = vi.fn(async () => ({ csrfToken: `token-${++n}` }));
  const api = { getCsrf, currentUser: vi.fn(async () => null) } as unknown as AuthApi;
  let auth: AuthContextValue | undefined;
  function Probe() {
    auth = useAuth();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AuthProvider api={api}>
        <Probe />
      </AuthProvider>,
    ),
  );

  const tokens = await Promise.all([
    auth!.getCsrfToken(),
    auth!.getCsrfToken(),
    auth!.getCsrfToken(),
  ]);
  expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
  expect(await auth!.getCsrfToken()).toBe('token-1');
  expect(getCsrf).toHaveBeenCalledTimes(1);

  expect(await auth!.getCsrfToken(true)).toBe('token-2');
  expect(await auth!.getCsrfToken()).toBe('token-2');
  expect(getCsrf).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});
