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
  type CredentialsInput,
} from './api.js';

export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly loading: boolean;
  getCsrfToken(): Promise<string>;
  login(input: CredentialsInput): Promise<AuthSessionResponse>;
  register(input: CredentialsInput): Promise<AuthSessionResponse>;
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
    async (input: CredentialsInput): Promise<AuthSessionResponse> => {
      const session = await authApi.register(input);
      setUser(session.user);
      return session;
    },
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
    () => ({ getCsrfToken, loading, login, logout, refresh, register, user }),
    [getCsrfToken, loading, login, logout, refresh, register, user],
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
