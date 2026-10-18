import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from '../lib/api';
import { useToast } from '../ui/Toast';
import { session, type Session, type SessionUser } from './session';

interface AuthState {
  user: SessionUser | null;
  token: string | null;
  login(email: string, password: string): Promise<void>;
  logout(reason?: 'expired' | 'manual'): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Session | null>(() => session.get());
  const queryClient = useQueryClient();
  const toast = useToast();

  const logout = useCallback(
    (reason: 'expired' | 'manual' = 'manual') => {
      const token = session.get()?.token;
      if (!token && reason === 'expired') return; // parallel 401s: the first one already ended the session
      session.clear();
      setState(null);
      queryClient.clear(); // nothing of this user's data survives the session
      if (token && reason === 'manual')
        void fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined); // the server revokes the token; the client has already forgotten it
      if (reason === 'expired')
        toast({ tone: 'info', title: 'Your session ended', body: 'Sign in again to continue.' });
    },
    [queryClient, toast],
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ token: string; expiresAt: number; user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
    const s = { token: res.token, expiresAt: res.expiresAt, user: res.user };
    session.set(s);
    setState(s);
  }, []);

  // Any 401 on an authenticated call (expired, revoked, disabled) ends the session.
  useEffect(() => {
    setUnauthorizedHandler(() => logout('expired'));
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  // Log out when the token expires, even if the user does nothing.
  useEffect(() => {
    if (!state) return;
    const ms = state.expiresAt * 1000 - Date.now();
    const timer = setTimeout(() => logout('expired'), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [state, logout]);

  // The server re-reads the role on every request: refresh it so a demotion shows up in the UI too.
  useEffect(() => {
    if (!state?.token) return;
    const ctrl = new AbortController();
    api<{ user: SessionUser }>('/api/auth/me', { signal: ctrl.signal })
      .then(({ user }) => {
        if (user.role !== state.user.role || user.name !== state.user.name) {
          const s = { ...state, user };
          session.set(s);
          setState(s);
        }
      })
      .catch(() => undefined); // a 401 already logged out through the handler
    return () => ctrl.abort();
  }, [state]);

  const value = useMemo<AuthState>(
    () => ({ user: state?.user ?? null, token: state?.token ?? null, login, logout }),
    [state, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
