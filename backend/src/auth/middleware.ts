import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { unauthenticated } from '../shared/errors';
import type { AppContext } from '../shared/http';
import type { Role } from '../rbac/permissions';
import { isRevoked, verifyToken } from './tokens';

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: number;
}

/**
 * Bearer JWT -> req.user. The token proves identity; the role and the active flag are re-read from the DB on
 * every request, so demoting or disabling a user takes effect at once, not when the token expires.
 */
export function authenticate(ctx: AppContext): RequestHandler {
  const findUser = ctx.db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?');
  return (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
    if (!m) return next(unauthenticated());
    let claims;
    try {
      claims = verifyToken(m[1], ctx.config);
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
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      jti: claims.jti,
      exp: claims.exp,
    };
    next();
  };
}
