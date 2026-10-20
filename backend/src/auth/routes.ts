import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Db } from '../db';
import { conflict, HttpError, unauthenticated } from '../shared/errors';
import { defineRoute, type AppContext, type RouteDef } from '../shared/http';
import { decryptSecret, encryptSecret } from '../shared/secretbox';
import type { Role } from '../rbac/permissions';
import { dummyHash, hashPassword, passwordSchema, verifyPassword } from './password';
import { clearSessionCookie, startSession } from './session';
import { revoke, signMfaToken, verifyMfaToken } from './tokens';
import { base32Decode, base32Encode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp';

export const MAX_FAILURES = 5; // consecutive failures per account before backoff
export const LOCK_BASE_MS = 60_000; // 1 min, doubling per further failure
export const LOCK_MAX_MS = 15 * 60_000;
export const LOGIN_LIMIT_PER_MIN = 10; // per IP (default of LOGIN_RATE_LIMIT_PER_MIN)

const GENERIC = 'Invalid email or password';

interface LoginRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  password_hash: string;
  active: number;
  must_change_password: number;
  totp_enabled: number;
  totp_secret_enc: string | null;
  totp_last_step: number;
}

const USER_COLUMNS =
  'id, name, email, role, password_hash, active, must_change_password, totp_enabled, totp_secret_enc, totp_last_step';

export function publicUser(u: { id: number; email: string; name: string; role: Role }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const code6 = z.string().regex(/^\d{6}$/, 'must be the 6-digit code from the authenticator app');
const recoveryCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, 'must look like abcd-efgh-jkmn');

// ---------------------------------------------------------------- per-account lockout (login and TOTP)

function assertNotLocked(db: Db, email: string, req: Request, audit: AppContext['audit']) {
  const attempt = db.prepare('SELECT locked_until FROM login_attempts WHERE email = ?').get(email) as
    { locked_until: number } | undefined;
  const now = Date.now();
  if (attempt && attempt.locked_until > now) {
    const retry = Math.ceil((attempt.locked_until - now) / 1000);
    audit.append('system', 'AUTH_FAIL', { email, reason: 'LOCKED', ip: req.ip });
    throw new HttpError(429, 'ACCOUNT_LOCKED', `Too many failed attempts, try again in ${retry} s`, {
      retryAfterS: retry,
    });
  }
}

function recordFailure(db: Db, email: string): number {
  const prev = db.prepare('SELECT failures FROM login_attempts WHERE email = ?').pluck().get(email) as
    number | undefined;
  const failures = (prev ?? 0) + 1;
  const lockedUntil =
    failures >= MAX_FAILURES
      ? Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (failures - MAX_FAILURES))
      : 0;
  db.prepare(
    `INSERT INTO login_attempts (email, failures, locked_until) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
  ).run(email, failures, lockedUntil);
  return failures;
}

const totpSecretOf = (row: LoginRow, key: string) => base32Decode(decryptSecret(row.totp_secret_enc!, key));

/** A fresh limiter per app instance, so tests do not share counters. */
export function authRoutes(perMinute = LOGIN_LIMIT_PER_MIN): RouteDef[] {
  const limiter = (message: string) =>
    rateLimit({
      windowMs: 60_000,
      limit: perMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', message)),
    });
  const loginLimiter = limiter('Too many login attempts, try again in a minute');
  const accountLimiter = () => limiter('Too many attempts, try again in a minute'); // one per route

  return [
    defineRoute({
      method: 'post',
      path: '/api/auth/login',
      access: 'public',
      middleware: [loginLimiter],
      body: z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(200) }),
      async handler({ body, req, res }, { db, config, audit }) {
        const email = body.email.toLowerCase();
        assertNotLocked(db, email, req, audit);
        const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(email) as
          LoginRow | undefined;
        // Always run one bcrypt compare, against a dummy hash if the account does not exist: same time, same message.
        const passwordOk = await verifyPassword(
          body.password,
          user?.password_hash ?? dummyHash(config.BCRYPT_COST),
        );
        if (!user || !user.active || !passwordOk) {
          const failures = recordFailure(db, email);
          audit.append('system', 'AUTH_FAIL', { email, reason: 'BAD_CREDENTIALS', failures, ip: req.ip });
          throw unauthenticated(GENERIC, 'INVALID_CREDENTIALS');
        }
        if (user.totp_enabled) {
          // the password was right; the session waits for the code (POST /api/auth/totp/verify)
          return { mfaRequired: true, mfaToken: signMfaToken(user.id, config) };
        }
        db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
        audit.append(`user:${user.id}`, 'AUTH_LOGIN', { user_id: user.id, email, ip: req.ip });
        return startSession(req, res, user, config);
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/auth/totp/verify',
      access: 'public', // carries the MFA token instead of a session
      middleware: [loginLimiter],
      body: z
        .strictObject({
          mfaToken: z.string().max(2000),
          code: code6.optional(),
          recoveryCode: recoveryCode.optional(),
        })
        .refine((b) => !!b.code !== !!b.recoveryCode, 'send either code or recoveryCode'),
      async handler({ body, req, res }, { db, config, audit }) {
        let pending;
        try {
          pending = verifyMfaToken(body.mfaToken, config);
        } catch (err) {
          throw unauthenticated(
            err instanceof jwt.TokenExpiredError
              ? 'Sign-in timed out: enter your password again'
              : 'Invalid token',
            err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
          );
        }
        const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(pending.userId) as
          LoginRow | undefined;
        if (!user || !user.active || !user.totp_enabled)
          throw unauthenticated(GENERIC, 'INVALID_CREDENTIALS');
        assertNotLocked(db, user.email, req, audit);

        let how: 'totp' | 'recovery_code';
        if (body.code) {
          const step = verifyTotp(
            totpSecretOf(user, config.APP_SECRET_KEY),
            body.code,
            Date.now() / 1000,
            user.totp_last_step,
          );
          if (step === null) {
            const failures = recordFailure(db, user.email);
            audit.append('system', 'AUTH_FAIL', {
              email: user.email,
              reason: 'BAD_TOTP',
              failures,
              ip: req.ip,
            });
            throw unauthenticated('That code is not right or already used', 'INVALID_CODE');
          }
          db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id); // no reuse
          how = 'totp';
        } else {
          const want = Buffer.from(sha256(body.recoveryCode!));
          const rows = db
            .prepare('SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL')
            .all(user.id) as { id: number; code_hash: string }[];
          const hit = rows.find((r) => timingSafeEqual(Buffer.from(r.code_hash), want));
          if (!hit) {
            const failures = recordFailure(db, user.email);
            audit.append('system', 'AUTH_FAIL', {
              email: user.email,
              reason: 'BAD_RECOVERY_CODE',
              failures,
              ip: req.ip,
            });
            throw unauthenticated('That recovery code is not right or already used', 'INVALID_CODE');
          }
          db.prepare('UPDATE totp_recovery_codes SET used_at = ? WHERE id = ?').run(Date.now(), hit.id);
          how = 'recovery_code';
        }
        revoke(db, pending.jti, pending.exp); // one MFA token, one session
        db.prepare('DELETE FROM login_attempts WHERE email = ?').run(user.email);
        audit.append(`user:${user.id}`, 'AUTH_LOGIN', {
          user_id: user.id,
          email: user.email,
          ip: req.ip,
          mfa: how,
        });
        return startSession(req, res, user, config);
      },
    }),

    defineRoute({
      method: 'get',
      path: '/api/auth/me',
      access: 'authenticated',
      handler: ({ user }, { config }) => ({
        user: publicUser(user!),
        mustChangePassword: !!user!.mustChangePassword,
        totpEnabled: !!user!.totpEnabled,
        mfaSetupRequired: config.REQUIRE_ADMIN_MFA && user!.role === 'ADMIN' && !user!.totpEnabled,
      }),
    }),

    defineRoute({
      method: 'post',
      path: '/api/auth/logout',
      access: 'authenticated',
      handler({ user, res }, { db, config }) {
        revoke(db, user!.jti, user!.exp); // the server refuses this token from now on
        clearSessionCookie(res, config);
        res.status(204).end();
      },
    }),

    // S2: change your own password. Every other session of the account ends; this one gets a fresh token.
    defineRoute({
      method: 'post',
      path: '/api/auth/password',
      access: 'authenticated',
      middleware: [accountLimiter()],
      body: z.strictObject({ current: z.string().min(1).max(200), next: passwordSchema }),
      async handler({ body, user, req, res }, { db, config, audit }) {
        const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(user!.id) as LoginRow;
        if (!(await verifyPassword(body.current, row.password_hash))) {
          audit.append('system', 'AUTH_FAIL', {
            email: row.email,
            reason: 'PASSWORD_CHANGE_BAD_CURRENT',
            ip: req.ip,
          });
          // 400, not 401: the session is fine (a 401 makes the app sign the user out)
          throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'The current password is not right');
        }
        if (await verifyPassword(body.next, row.password_hash))
          throw new HttpError(400, 'BAD_REQUEST', 'The new password must differ from the current one');
        const hash = await hashPassword(body.next, config.BCRYPT_COST);
        const nowS = Math.floor(Date.now() / 1000);
        db.prepare(
          'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?',
        ).run(hash, nowS, Date.now(), row.id);
        revoke(db, user!.jti, user!.exp);
        audit.append(`user:${row.id}`, 'USER_UPDATED', { user_id: row.id, fields: ['password'], by: 'self' });
        return startSession(req, res, { ...row, must_change_password: 0 }, config);
      },
    }),

    // S3: TOTP. Setup stores a secret that only counts once a code from it is confirmed.
    defineRoute({
      method: 'post',
      path: '/api/auth/totp/setup',
      access: 'authenticated',
      middleware: [accountLimiter()],
      async handler({ user }, { db, config }) {
        if (user!.totpEnabled) throw conflict('TOTP_ENABLED', 'Two-factor sign-in is already on');
        const secret = base32Encode(newTotpSecret());
        db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = 0 WHERE id = ?').run(
          encryptSecret(secret, config.APP_SECRET_KEY),
          user!.id,
        );
        const uri = otpauthUri(secret, user!.email);
        // the QR an authenticator app scans; the secret is also shown for typing it in by hand
        const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return { secret, otpauthUri: uri, qrSvg };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/auth/totp/confirm',
      access: 'authenticated',
      middleware: [accountLimiter()],
      body: z.strictObject({ code: code6 }),
      handler({ body, user }, { db, config, audit }) {
        const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(user!.id) as LoginRow;
        if (row.totp_enabled) throw conflict('TOTP_ENABLED', 'Two-factor sign-in is already on');
        if (!row.totp_secret_enc) throw conflict('TOTP_NOT_SET_UP', 'Start the setup first');
        const step = verifyTotp(totpSecretOf(row, config.APP_SECRET_KEY), body.code, Date.now() / 1000, 0);
        if (step === null)
          throw new HttpError(400, 'INVALID_CODE', 'That code is not right: check the time on your phone');
        const codes = newRecoveryCodes();
        db.transaction(() => {
          db.prepare(
            'UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?',
          ).run(step, Date.now(), row.id);
          db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(row.id);
          const insert = db.prepare('INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (?, ?)');
          for (const c of codes) insert.run(row.id, sha256(c));
        })();
        audit.append(`user:${row.id}`, 'USER_UPDATED', {
          user_id: row.id,
          fields: ['totp'],
          totp: 'enabled',
        });
        return { totpEnabled: true, recoveryCodes: codes }; // shown once, never stored in clear
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/auth/totp/disable',
      access: 'authenticated',
      middleware: [accountLimiter()],
      body: z.strictObject({ code: code6 }),
      handler({ body, user }, { db, config, audit }) {
        const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(user!.id) as LoginRow;
        if (!row.totp_enabled) throw conflict('TOTP_NOT_ENABLED', 'Two-factor sign-in is not on');
        if (config.REQUIRE_ADMIN_MFA && row.role === 'ADMIN')
          throw conflict('MFA_REQUIRED', 'Two-factor sign-in is required for Admins here');
        const step = verifyTotp(
          totpSecretOf(row, config.APP_SECRET_KEY),
          body.code,
          Date.now() / 1000,
          row.totp_last_step,
        );
        if (step === null) throw new HttpError(400, 'INVALID_CODE', 'That code is not right or already used');
        db.transaction(() => {
          db.prepare(
            'UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?',
          ).run(Date.now(), row.id);
          db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(row.id);
        })();
        audit.append(`user:${row.id}`, 'USER_UPDATED', {
          user_id: row.id,
          fields: ['totp'],
          totp: 'disabled',
        });
        return { totpEnabled: false };
      },
    }),
  ];
}
