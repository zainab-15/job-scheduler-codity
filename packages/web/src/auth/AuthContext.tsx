import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, clearToken, getToken, setToken, setUnauthorizedHandler } from '../api/client';
import type { LoginResponse, MeResponse, RegisterResponse } from '../api/types';

interface AuthState {
  token: string | null;
  userEmail: string | null;
  orgName: string | null;
}

interface AuthContextValue extends AuthState {
  isAuthed: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, orgName: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMAIL_KEY = 'scheduler.email';
const ORG_KEY = 'scheduler.org';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({
    token: getToken(),
    userEmail: localStorage.getItem(EMAIL_KEY),
    orgName: localStorage.getItem(ORG_KEY),
  }));

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem(ORG_KEY);
    setState({ token: null, userEmail: null, orgName: null });
  }, []);

  // Wire the axios 401 handler to logout (R19 already exempts /auth/* routes).
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  const persist = useCallback((token: string, email: string, orgName: string) => {
    setToken(token);
    localStorage.setItem(EMAIL_KEY, email);
    localStorage.setItem(ORG_KEY, orgName);
    setState({ token, userEmail: email, orgName });
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await api.post<LoginResponse>('/api/v1/auth/login', { email, password });
      // login response has no org name; fetch it from /me for the shell header.
      setToken(data.token);
      const me = await api.get<MeResponse>('/auth/me');
      persist(data.token, data.user.email, me.data.organization.name);
    },
    [persist],
  );

  const register = useCallback(
    async (email: string, password: string, orgName: string) => {
      const { data } = await api.post<RegisterResponse>('/auth/register', { email, password, org_name: orgName });
      persist(data.token, data.user.email, data.organization.name);
    },
    [persist],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, isAuthed: !!state.token, login, register, logout }),
    [state, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
