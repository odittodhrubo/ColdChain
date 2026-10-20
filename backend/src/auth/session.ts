// Browser sessions (S1): the JWT travels in an HttpOnly cookie, so no script on the page can read it.
// Scripts, tools and tests keep `Authorization: Bearer`; they ask for the token in the login body with
// `X-Auth-Mode: token`. Getting a token that way needs the password, so it adds nothing for an XSS.
import type { Request, Response } from 'express';
import type { Config } from '../config';
import type { Role } from '../rbac/permissions';
import { signToken } from './tokens';

export const SESSION_COOKIE = 'cc_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** One cookie value from a Cookie header (no dependency for a single cookie). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function tokenFromRequest(req: Request): { token: string; via: 'bearer' | 'cookie' } | null {
  const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.get('authorization') ?? '');
  if (m) return { token: m[1], via: 'bearer' };
  const c = readCookie(req.get('cookie'), SESSION_COOKIE);
  return c && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(c) ? { token: c, via: 'cookie' } : null;
}

/**
 * CSRF for cookie sessions: a state-changing request must come from the web app's own origin. SameSite=Strict
 * already keeps the cookie off cross-site requests; this is the second line (old browsers, misconfigured proxies).
 */
export function sameOrigin(req: Request, config: Config): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const allowed = new URL(config.CORS_ORIGIN).origin;
  const origin = req.get('origin');
  if (origin) return origin === allowed;
  const referer = req.get('referer');
  if (!referer) return false; // a browser always sends one of the two on a cross-origin-capable write
  try {
    return new URL(referer).origin === allowed;
  } catch {
    return false;
  }
}

export function setSessionCookie(res: Response, token: string, exp: number, config: Config) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: Math.max(0, exp * 1000 - Date.now()),
  });
}

export function clearSessionCookie(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

export const wantsTokenInBody = (req: Request) => req.get('x-auth-mode') === 'token';

/** Signs a session, sets the cookie, and returns the login response body. */
export function startSession(
  req: Request,
  res: Response,
  user: {
    id: number;
    email: string;
    name: string;
    role: Role;
    must_change_password: number;
    totp_enabled: number;
  },
  config: Config,
) {
  const { token, exp } = signToken(user, config);
  setSessionCookie(res, token, exp, config);
  return {
    expiresAt: exp,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    mustChangePassword: user.must_change_password === 1,
    totpEnabled: user.totp_enabled === 1,
    mfaSetupRequired: config.REQUIRE_ADMIN_MFA && user.role === 'ADMIN' && user.totp_enabled !== 1,
    ...(wantsTokenInBody(req) ? { token } : {}),
  };
}
