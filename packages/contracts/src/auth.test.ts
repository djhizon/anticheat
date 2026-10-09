import { describe, expect, it } from 'vitest';

import type {
  AuthSessionResponse,
  AuthUser,
  CurrentUserResponse,
  LoginRequest,
  RegisterRequest,
} from './auth.js';

describe('authentication contracts', () => {
  it('keeps credential inputs separate from public user data', () => {
    const register: RegisterRequest = {
      email: 'student@example.test',
      password: 'not returned to a caller',
    };
    const login: LoginRequest = register;
    const user: AuthUser = {
      id: 'user-1' as AuthUser['id'],
      email: register.email,
      role: 'student',
    };
    const session: AuthSessionResponse = {
      user,
      csrfToken: 'csrf-1' as AuthSessionResponse['csrfToken'],
      expiresAt: '2026-09-15T00:00:00.000Z',
    };
    const currentUser: CurrentUserResponse = { user };

    expect(login).toEqual(register);
    expect(session.user).toEqual(currentUser.user);
    expect(session).not.toHaveProperty('password');
  });
});
