import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  createAuthApi,
  type AuthApi,
  type AuthSessionResponse,
  type AuthUser,
  type ConfirmLinkType,
  type ConfirmResponse,
  type CredentialsInput,
  type PendingConfirmationResponse,
  type RegisterResponse,
} from './api.js';

export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly loading: boolean;
  getCsrfToken(): Promise<string>;
  login(input: CredentialsInput): Promise<AuthSessionResponse>;
  register(input: CredentialsInput): Promise<RegisterResponse>;
  forgotPassword(email: string): Promise<void>;
  confirm(input: {
    readonly tokenHash: string;
    readonly type: ConfirmLinkType;
  }): Promise<ConfirmResponse>;
  resetPassword(password: string): Promise<void>;
  changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void>;
  changeEmail(input: {
    readonly newEmail: string;
    readonly currentPassword: string;
  }): Promise<PendingConfirmationResponse>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

export interface AuthProviderProps {
  readonly children: ReactNode;
  readonly api?: AuthApi;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, api }: AuthProviderProps): ReactNode {
  const authApi = useMemo(() => api ?? createAuthApi(), [api]);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await authApi.currentUser());
    } finally {
      setLoading(false);
    }
  }, [authApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (input: CredentialsInput): Promise<AuthSessionResponse> => {
      const session = await authApi.login(input);
      setUser(session.user);
      return session;
    },
    [authApi],
  );

  const register = useCallback(
    async (input: CredentialsInput): Promise<RegisterResponse> => {
      const result = await authApi.register(input);
      if ('user' in result) {
        setUser(result.user);
      }
      return result;
    },
    [authApi],
  );

  const forgotPassword = useCallback(
    (email: string): Promise<void> => authApi.forgotPassword(email),
    [authApi],
  );

  const confirm = useCallback(
    async (input: {
      readonly tokenHash: string;
      readonly type: ConfirmLinkType;
    }): Promise<ConfirmResponse> => {
      const result = await authApi.confirm(input);
      if ('user' in result) {
        setUser(result.user);
      }
      return result;
    },
    [authApi],
  );

  const resetPassword = useCallback(
    (password: string): Promise<void> => authApi.resetPassword(password),
    [authApi],
  );

  const changePassword = useCallback(
    (input: { readonly currentPassword: string; readonly newPassword: string }) =>
      authApi.changePassword(input),
    [authApi],
  );

  const changeEmail = useCallback(
    (input: { readonly newEmail: string; readonly currentPassword: string }) =>
      authApi.changeEmail(input),
    [authApi],
  );

  const logout = useCallback(async (): Promise<void> => {
    await authApi.logout();
    setUser(null);
  }, [authApi]);

  const getCsrfToken = useCallback(async (): Promise<string> => {
    return (await authApi.getCsrf()).csrfToken;
  }, [authApi]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      changeEmail,
      changePassword,
      confirm,
      forgotPassword,
      getCsrfToken,
      loading,
      login,
      logout,
      refresh,
      register,
      resetPassword,
      user,
    }),
    [
      changeEmail,
      changePassword,
      confirm,
      forgotPassword,
      getCsrfToken,
      loading,
      login,
      logout,
      refresh,
      register,
      resetPassword,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }

  return context;
}
