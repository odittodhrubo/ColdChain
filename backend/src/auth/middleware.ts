import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError, unauthenticated } from '../shared/errors';
import type { AppContext } from '../shared/http';
import type { Role } from '../rbac/permissions';
import { sameOrigin, tokenFromRequest } from './session';
import { isRevoked, verifyToken } from './tokens';

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: number;
  must_change_password: number;
  password_changed_at: number;
  totp_enabled: number;
}

// What a user who must change their password (S2) or set up TOTP (S3) can still reach.
const ACCOUNT_ROUTES = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/password',
  '/api/auth/totp/setup',
  '/api/auth/totp/confirm',
]);

/**
 * Session JWT (HttpOnly cookie from the browser, or Bearer from scripts) -> req.user. The token proves identity;
 * the role, the active flag and the account state are re-read from the DB on every request, so demoting,
 * disabling or a password change takes effect at once, not when the token expires.
 */
export function authenticate(ctx: AppContext): RequestHandler {
  const findUser = ctx.db.prepare(
    `SELECT id, email, name, role, active, must_change_password, password_changed_at, totp_enabled
     FROM users WHERE id = ?`,
  );
  return (req, _res, next) => {
    const found = tokenFromRequest(req);
    if (!found) return next(unauthenticated());
    let claims;
    try {
      claims = verifyToken(found.token, ctx.config);
    } catch (err) {
      return next(
        err instanceof jwt.TokenExpiredError
          ? unauthenticated('Session expired', 'TOKEN_EXPIRED')
          : unauthenticated('Invalid token', 'INVALID_TOKEN'),
      );
    }
    if (isRevoked(ctx.db, claims.jti)) return next(unauthenticated('Session ended', 'TOKEN_REVOKED'));
    const user = findUser.get(Number(claims.sub)) as UserRow | undefined;
    if (!user || !user.active) return next(unauthenticated('Account disabled', 'ACCOUNT_DISABLED'));
    if (claims.iat < user.password_changed_at)
      return next(unauthenticated('Session ended: the password was changed', 'TOKEN_REVOKED'));
    // CSRF (S1): a cookie is sent automatically, so a write that relies on it must come from the app's origin
    if (found.via === 'cookie' && !sameOrigin(req, ctx.config))
      return next(
        new HttpError(403, 'CSRF_ORIGIN', 'Request refused: it did not come from the ColdChain app'),
      );
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      jti: claims.jti,
      exp: claims.exp,
      mustChangePassword: user.must_change_password === 1,
      totpEnabled: user.totp_enabled === 1,
    };
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    if (!ACCOUNT_ROUTES.has(route)) {
      if (user.must_change_password)
        return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password to continue'));
      if (ctx.config.REQUIRE_ADMIN_MFA && user.role === 'ADMIN' && !user.totp_enabled)
        return next(new HttpError(403, 'MFA_SETUP_REQUIRED', 'Set up two-factor sign-in to continue'));
    }
    next();
  };
}
