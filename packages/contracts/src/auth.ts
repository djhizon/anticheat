import type { Opaque, UserId, UserRole } from './common.js';

export type SessionId = Opaque<string, 'SessionId'>;
export type SessionToken = Opaque<string, 'SessionToken'>;
export type CsrfToken = Opaque<string, 'CsrfToken'>;

export interface RegisterRequest {
  readonly email: string;
  readonly password: string;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface AuthUser {
  readonly id: UserId;
  readonly email: string;
  readonly role: UserRole;
}

export interface AuthSessionResponse {
  readonly user: AuthUser;
  readonly csrfToken: CsrfToken;
  readonly expiresAt: string;
}

export interface CurrentUserResponse {
  readonly user: AuthUser;
}
