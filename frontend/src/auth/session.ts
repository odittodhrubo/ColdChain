import type { Role } from './permissions';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface Session {
  token: string;
  expiresAt: number; // unix seconds (JWT exp)
  user: SessionUser;
}

// The token lives in memory, mirrored to sessionStorage so a reload keeps the session in this tab only.
// Never localStorage: any script on the origin could read it there long after the tab closed.
const KEY = 'coldchain.session';
let current: Session | null | undefined;

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    return s && s.expiresAt * 1000 > Date.now() ? s : null;
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
    current = s;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
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
