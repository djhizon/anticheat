import { expect, test } from '@playwright/test';

// Exercise the Electron-only post-login branch without inspecting or closing
// real desktop applications. This does not substitute for a native smoke test.
for (const mode of ['success', 'reject', 'hang', 'malformed', 'blocked'] as const) {
  test(`desktop login recovers from ${mode} preflight`, async ({ page }) => {
    let signedIn = false;
    const user = { id: 'demo-student', email: 'demo.student@example.test', role: 'student' };
    await page.route('**/auth/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/auth/login') signedIn = true;
      if (pathname === '/auth/logout') signedIn = false;
      const body =
        pathname === '/auth/csrf'
          ? { csrfToken: 'test-csrf' }
          : pathname === '/auth/login'
            ? { user, csrfToken: 'test-csrf', expiresAt: '2030-01-01T00:00:00Z' }
            : pathname === '/auth/me' && !signedIn
              ? { code: 'unauthorized', message: 'Sign in' }
              : { user };
      await route.fulfill({ status: pathname === '/auth/me' && !signedIn ? 401 : 200, json: body });
    });
    await page.route('**/exam/assignments', (route) =>
      route.fulfill({ json: { assignments: [] } }),
    );
    await page.addInitScript((mode) => {
      Object.defineProperty(window, 'electronExam', {
        value: {
          getDisplayCount: () => (mode === 'hang' ? new Promise(() => {}) : Promise.resolve(1)),
          listAppTargets: () =>
            mode === 'reject'
              ? Promise.reject(new Error('IPC failure'))
              : Promise.resolve(
                  mode === 'malformed'
                    ? null
                    : [
                        {
                          id: 'fixture',
                          name: mode === 'blocked' ? 'Notes' : 'Exam Anti-Cheat',
                          exempt: mode !== 'blocked',
                          protected: mode !== 'blocked',
                          reason: '',
                          canForce: false,
                        },
                      ],
                ),
        },
      });
    }, mode);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Fill demo login' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    if (mode === 'success') {
      await expect(page.getByRole('heading', { name: 'Your assigned exams' })).toBeVisible();
    } else {
      if (mode === 'blocked') await expect(page.getByText('Notes', { exact: true })).toBeVisible();
      else
        await expect(page.getByRole('alert')).toContainText(
          mode === 'hang' ? 'timed out' : 'failed',
          { timeout: 12000 },
        );
      await expect(page.getByRole('button', { name: 'Re-check Environment' })).toBeVisible();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
