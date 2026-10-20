import type { Role } from './permissions';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

/** What the page knows about the session. The token itself is an HttpOnly cookie: no script can read it. */
export interface Session {
  expiresAt: number; // unix seconds (JWT exp)
  user: SessionUser;
  mustChangePassword?: boolean; // a password someone else set: change it before anything else
  totpEnabled?: boolean;
  mfaSetupRequired?: boolean; // an Admin where two-factor is mandatory and not set up yet
}

/** The login / password-change response body. */
export type SessionResponse = Session;

// Mirrored to sessionStorage so a reload in this tab knows who is signed in (the cookie does the proving).
// Never localStorage, and never the token: that stays in the HttpOnly cookie.
const KEY = 'coldchain.session';
let current: Session | null | undefined;

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Session & { token?: unknown }) : null;
    if (!s || s.expiresAt * 1000 <= Date.now()) return null;
    if ('token' in s) return null; // stored by a version that kept the token in the page: sign in again
    return s;
  } catch {
    return null;
  }
}

export const session = {
  get(): Session | null {
    if (current === undefined) current = load();
    if (current && current.expiresAt * 1000 <= Date.now()) session.clear();
    return current ?? null;
  },
  set(s: Session) {
    current = {
      expiresAt: s.expiresAt,
      user: s.user,
      mustChangePassword: s.mustChangePassword,
      totpEnabled: s.totpEnabled,
      mfaSetupRequired: s.mfaSetupRequired,
    }; // whitelisted: a token in a response body never lands here
    try {
      sessionStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // storage blocked: the session still works for this page view
    }
  },
  clear() {
    current = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // nothing to remove
    }
  },
  /** test hook: forget the in-memory copy so the next get() reads storage again */
  reset() {
    current = undefined;
  },
};

/** Changes with every new sign-in: the realtime connection is re-opened per session. */
export const sessionKey = (s: Session | null) => (s ? `${s.user.id}:${s.expiresAt}` : null);
