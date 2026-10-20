import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from '../lib/api';
import { useToast } from '../ui/Toast';
import { session, sessionKey, type Session, type SessionResponse, type SessionUser } from './session';

export type LoginResult = 'signed-in' | 'mfa';
export type MfaProof = { code: string } | { recoveryCode: string };

interface AuthState {
  user: SessionUser | null;
  /** Changes with every new sign-in (the realtime connection follows it); null when signed out. */
  sessionKey: string | null;
  mustChangePassword: boolean;
  mfaSetupRequired: boolean;
  totpEnabled: boolean;
  /** The password was right and a two-factor code is due (an MFA token is held in memory only). */
  mfaPending: boolean;
  login(email: string, password: string): Promise<LoginResult>;
  verifyMfa(proof: MfaProof): Promise<void>;
  cancelMfa(): void;
  /** A new session from the server (after a password change), or new account flags. */
  update(s: SessionResponse | Partial<Pick<Session, 'totpEnabled' | 'mfaSetupRequired'>>): void;
  logout(reason?: 'expired' | 'manual'): void;
}

const AuthContext = createContext<AuthState | null>(null);

type LoginResponse = SessionResponse | { mfaRequired: true; mfaToken: string };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Session | null>(() => session.get());
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const start = useCallback((s: SessionResponse) => {
    session.set(s);
    setState(session.get());
  }, []);

  const logout = useCallback(
    (reason: 'expired' | 'manual' = 'manual') => {
      const was = session.get();
      if (!was && reason === 'expired') return; // parallel 401s: the first one already ended the session
      session.clear();
      setState(null);
      setMfaToken(null);
      queryClient.clear(); // nothing of this user's data survives the session
      if (was && reason === 'manual')
        // the server revokes the token and clears the HttpOnly cookie; the page has already forgotten the user
        void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
      if (reason === 'expired')
        toast({ tone: 'info', title: 'Your session ended', body: 'Sign in again to continue.' });
    },
    [queryClient, toast],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        auth: false,
      });
      if ('mfaRequired' in res) {
        setMfaToken(res.mfaToken);
        return 'mfa';
      }
      start(res);
      return 'signed-in';
    },
    [start],
  );

  const verifyMfa = useCallback(
    async (proof: MfaProof) => {
      const res = await api<SessionResponse>('/api/auth/totp/verify', {
        method: 'POST',
        body: { mfaToken, ...proof },
        auth: false,
      });
      setMfaToken(null);
      start(res);
    },
    [mfaToken, start],
  );

  const update = useCallback<AuthState['update']>(
    (s) => {
      if ('user' in s && 'expiresAt' in s) return start(s);
      const cur = session.get();
      if (!cur) return;
      start({ ...cur, ...s });
    },
    [start],
  );

  // Any 401 on an authenticated call (expired, revoked, disabled) ends the session.
  useEffect(() => {
    setUnauthorizedHandler(() => logout('expired'));
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  // Log out when the session expires, even if the user does nothing.
  useEffect(() => {
    if (!state) return;
    const ms = state.expiresAt * 1000 - Date.now();
    const timer = setTimeout(() => logout('expired'), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [state, logout]);

  // The server re-reads the role and the account state on every request: refresh them so a demotion, or a
  // password an Admin reset, shows up in the UI too.
  const key = sessionKey(state);
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    api<{ user: SessionUser; mustChangePassword: boolean; totpEnabled: boolean; mfaSetupRequired: boolean }>(
      '/api/auth/me',
      { signal: ctrl.signal },
    )
      .then((me) => {
        const cur = session.get();
        if (!cur) return;
        const next = { ...cur, ...me };
        if (JSON.stringify(next) !== JSON.stringify(cur)) start(next);
      })
      .catch(() => undefined); // a 401 already logged out through the handler
    return () => ctrl.abort();
  }, [key, start]);

  const value = useMemo<AuthState>(
    () => ({
      user: state?.user ?? null,
      sessionKey: key,
      mustChangePassword: !!state?.mustChangePassword,
      mfaSetupRequired: !!state?.mfaSetupRequired,
      totpEnabled: !!state?.totpEnabled,
      mfaPending: mfaToken !== null,
      login,
      verifyMfa,
      cancelMfa: () => setMfaToken(null),
      update,
      logout,
    }),
    [state, key, mfaToken, login, verifyMfa, update, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
