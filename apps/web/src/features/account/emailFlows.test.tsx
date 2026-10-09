// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthApiError, type AuthApi, type AuthUser, type ConfirmResponse } from '../auth/api.js';
import { AuthProvider } from '../auth/AuthProvider.js';
import { LoginPage } from '../auth/LoginPage.js';
import { AccountPanel } from './AccountPanel.js';
import { ConfirmPage, readConfirmParams } from './ConfirmPage.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const student: AuthUser = {
  id: 'u1',
  email: 'student@example.test',
  role: 'student',
  authProvider: 'supabase',
};
const session = { user: student, csrfToken: 'csrf', expiresAt: '2026-10-01T08:00:00.000Z' };

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getCsrf: vi.fn(async () => ({ csrfToken: 'csrf' })),
    register: vi.fn(async () => ({ status: 'confirmation_sent' as const })),
    login: vi.fn(async () => session),
    logout: vi.fn(async () => undefined),
    currentUser: vi.fn(async () => null),
    forgotPassword: vi.fn(async () => undefined),
    confirm: vi.fn(async (): Promise<ConfirmResponse> => ({ status: 'signed_in', ...session })),
    resetPassword: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    changeEmail: vi.fn(async () => ({ status: 'confirmation_sent' as const })),
    ...overrides,
  };
}

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});

async function render(ui: React.ReactElement, api: AuthApi): Promise<void> {
  await act(async () => root.render(<AuthProvider api={api}>{ui}</AuthProvider>));
}

function setInput(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) {
    throw new Error(`Missing input ${id}`);
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (button === undefined) {
    throw new Error(`Missing button ${text}`);
  }
  return act(async () => button.click());
}

describe('confirm page', () => {
  it('parses only known link types', () => {
    expect(readConfirmParams('?token_hash=abc&type=recovery')).toEqual({
      tokenHash: 'abc',
      type: 'recovery',
    });
    expect(readConfirmParams('?token_hash=abc&type=nope')).toBeNull();
    expect(readConfirmParams('?type=email')).toBeNull();
  });

  it('confirms once and goes to the workspace on signed_in', async () => {
    const api = fakeApi();
    const onNavigate = vi.fn();
    await render(<ConfirmPage onNavigate={onNavigate} search="?token_hash=th&type=email" />, api);

    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.confirm).toHaveBeenCalledWith({ tokenHash: 'th', type: 'email' });
    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('asks for a new password after recovery and submits it', async () => {
    const api = fakeApi({
      confirm: vi.fn(async (): Promise<ConfirmResponse> => ({
        status: 'reset_required',
        ...session,
      })),
    });
    const onNavigate = vi.fn();
    await render(
      <ConfirmPage onNavigate={onNavigate} search="?token_hash=th&type=recovery" />,
      api,
    );

    expect(container.textContent).toContain('Choose a new password');
    setInput('reset-password', 'new password 1');
    setInput('reset-confirm-password', 'different');
    await submit();
    expect(container.textContent).toContain('Passwords do not match.');
    expect(api.resetPassword).not.toHaveBeenCalled();

    setInput('reset-confirm-password', 'new password 1');
    await submit();
    expect(api.resetPassword).toHaveBeenCalledWith('new password 1');
    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('shows the email_changed message', async () => {
    const api = fakeApi({
      confirm: vi.fn(async (): Promise<ConfirmResponse> => ({ status: 'email_changed' })),
    });
    await render(
      <ConfirmPage onNavigate={vi.fn()} search="?token_hash=th&type=email_change" />,
      api,
    );
    expect(container.textContent).toContain('Your email address has been updated.');
  });

  it('explains an expired link and rejects incomplete links without calling the API', async () => {
    const expired = fakeApi({
      confirm: vi.fn(async () => {
        throw new AuthApiError({
          code: 'invalid_state',
          message: 'x',
          reason: 'link_invalid',
        });
      }),
    });
    await render(<ConfirmPage onNavigate={vi.fn()} search="?token_hash=th&type=email" />, expired);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'invalid or has expired',
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    const incomplete = fakeApi();
    await render(<ConfirmPage onNavigate={vi.fn()} search="" />, incomplete);
    expect(incomplete.confirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain('incomplete');
  });
});

describe('login page email flows', () => {
  it('sends a reset email through the forgot-password form', async () => {
    const api = fakeApi();
    await render(<LoginPage />, api);
    await click('Forgot password?');
    expect(container.textContent).toContain('Reset your password');
    expect(container.querySelector('#auth-password')).toBeNull();

    setInput('auth-email', 'student@example.test');
    await submit();
    expect(api.forgotPassword).toHaveBeenCalledWith('student@example.test');
    expect(container.textContent).toContain('a password reset link is on its way');
  });

  it('shows "Check your email" after sign-up needs confirmation', async () => {
    const api = fakeApi();
    await render(<LoginPage />, api);
    await click('Sign up');
    setInput('auth-email', 'new@example.test');
    setInput('auth-password', 'correct horse');
    setInput('auth-confirm-password', 'correct horse');
    await submit();

    expect(api.register).toHaveBeenCalled();
    expect(container.textContent).toContain('Check your email to confirm your account');
  });

  it('maps an unconfirmed-email login failure to a clear message', async () => {
    const api = fakeApi({
      login: vi.fn(async () => {
        throw new AuthApiError({
          code: 'forbidden',
          message: 'x',
          reason: 'email_not_confirmed',
        });
      }),
    });
    await render(<LoginPage />, api);
    setInput('auth-email', 'student@example.test');
    setInput('auth-password', 'whatever');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
  });
});

describe('account panel', () => {
  async function renderPanel(api: AuthApi): Promise<void> {
    const signedIn = fakeApi({ ...api, currentUser: vi.fn(async () => student) });
    await render(<AccountPanel onClose={vi.fn()} />, signedIn);
  }

  it('changes the password and offers change email for supabase accounts', async () => {
    const api = fakeApi();
    await renderPanel(api);
    expect(container.textContent).toContain('Change email');

    const form = container.querySelectorAll('form')[0];
    setInput('account-current-password', 'old password');
    setInput('account-new-password', 'new password');
    setInput('account-confirm-password', 'new password');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old password',
      newPassword: 'new password',
    });
    expect(container.textContent).toContain('Password updated.');
  });

  it('hides change email for local accounts', async () => {
    const api = fakeApi({
      currentUser: vi.fn(async () => ({ ...student, authProvider: 'local' as const })),
    });
    await render(<AccountPanel onClose={vi.fn()} />, api);
    expect(container.textContent).toContain('Change password');
    expect(container.textContent).not.toContain('Change email');
  });
});
