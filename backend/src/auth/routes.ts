import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { HttpError, unauthenticated } from '../shared/errors';
import { defineRoute, type RouteDef } from '../shared/http';
import type { Role } from '../rbac/permissions';
import { dummyHash, verifyPassword } from './password';
import { revoke, signToken } from './tokens';

export const MAX_FAILURES = 5; // consecutive failures per account before backoff
export const LOCK_BASE_MS = 60_000; // 1 min, doubling per further failure
export const LOCK_MAX_MS = 15 * 60_000;
export const LOGIN_LIMIT_PER_MIN = 10; // per IP

const GENERIC = 'Invalid email or password';

interface LoginRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  password_hash: string;
  active: number;
}

export function publicUser(u: { id: number; email: string; name: string; role: Role }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

/** A fresh limiter per app instance, so tests do not share counters. */
export function authRoutes(): RouteDef[] {
  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: LOGIN_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'RATE_LIMITED', 'Too many login attempts, try again in a minute')),
  });

  return [
    defineRoute({
      method: 'post',
      path: '/api/auth/login',
      access: 'public',
      middleware: [loginLimiter],
      body: z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(200) }),
      async handler({ body }, { db, config }) {
        const now = Date.now();
        const email = body.email.toLowerCase();
        const attempt = db
          .prepare('SELECT failures, locked_until FROM login_attempts WHERE email = ?')
          .get(email) as { failures: number; locked_until: number } | undefined;
        if (attempt && attempt.locked_until > now) {
          const retry = Math.ceil((attempt.locked_until - now) / 1000);
          throw new HttpError(429, 'ACCOUNT_LOCKED', `Too many failed attempts, try again in ${retry} s`, {
            retryAfterS: retry,
          });
        }

        const user = db
          .prepare('SELECT id, name, email, role, password_hash, active FROM users WHERE email = ?')
          .get(email) as LoginRow | undefined;
        // Always run one bcrypt compare, against a dummy hash if the account does not exist: same time, same message.
        const passwordOk = await verifyPassword(
          body.password,
          user?.password_hash ?? dummyHash(config.BCRYPT_COST),
        );
        if (!user || !user.active || !passwordOk) {
          const failures = (attempt?.failures ?? 0) + 1;
          const lockedUntil =
            failures >= MAX_FAILURES
              ? now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (failures - MAX_FAILURES))
              : 0;
          db.prepare(
            `INSERT INTO login_attempts (email, failures, locked_until) VALUES (?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
          ).run(email, failures, lockedUntil);
          throw unauthenticated(GENERIC, 'INVALID_CREDENTIALS');
        }

        db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
        const { token, exp } = signToken(user, config);
        return { token, expiresAt: exp, user: publicUser(user) };
      },
    }),

    defineRoute({
      method: 'get',
      path: '/api/auth/me',
      access: 'authenticated',
      handler: ({ user }) => ({ user: publicUser(user!) }),
    }),

    defineRoute({
      method: 'post',
      path: '/api/auth/logout',
      access: 'authenticated',
      handler({ user, res }, { db }) {
        revoke(db, user!.jti, user!.exp); // the client discards the token; the server refuses it from now on
        res.status(204).end();
      },
    }),
  ];
}
