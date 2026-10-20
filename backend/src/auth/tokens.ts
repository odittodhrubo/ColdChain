import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../config';
import type { Db } from '../db';
import type { Role } from '../rbac/permissions';

export interface TokenClaims {
  sub: string;
  role: Role;
  name: string;
  jti: string;
  exp: number;
  iat: number;
}

/** JWT_EXPIRES_IN in seconds: "3600" (plain number = seconds), "15m", "1h", "7d". */
export function expiresInSeconds(value: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(value);
  if (!m) throw new Error(`bad JWT_EXPIRES_IN: ${value}`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
}

/** Session token. `expiresInS` overrides JWT_EXPIRES_IN — used by the long-lived display token (P1). */
export function signToken(user: { id: number; role: Role; name: string }, config: Config, expiresInS?: number) {
  const jti = randomUUID();
  const token = jwt.sign({ role: user.role, name: user.name }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(user.id),
    jwtid: jti,
    expiresIn: expiresInS ?? expiresInSeconds(config.JWT_EXPIRES_IN),
  });
  return { token, jti, exp: (jwt.decode(token) as TokenClaims).exp };
}

// P1: a wall-display token lives 30 days (a pharmacy screen must not log out overnight); revoking it disables
// the display row, which the auth middleware re-reads on every request, so the screen stops at once.
export const DISPLAY_TOKEN_TTL_S = 30 * 86400;

/** Throws jsonwebtoken errors (TokenExpiredError, JsonWebTokenError) on any invalid token. */
export function verifyToken(token: string, config: Config): TokenClaims {
  const claims = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }); // pinned: no "none", no RS/HS swap
  if (typeof claims === 'string' || !claims.sub || !claims.jti || !claims.exp)
    throw new jwt.JsonWebTokenError('bad claims');
  if (claims.typ === MFA_TYP) throw new jwt.JsonWebTokenError('not a session'); // password done, code pending
  return claims as TokenClaims;
}

// S3: after a correct password, a user with TOTP gets this instead of a session: good for 5 minutes, and only
// for POST /api/auth/totp/verify. A session check refuses it (verifyToken above).
const MFA_TYP = 'mfa_pending';
export const MFA_TOKEN_TTL_S = 300;

export function signMfaToken(userId: number, config: Config): string {
  return jwt.sign({ typ: MFA_TYP }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(userId),
    jwtid: randomUUID(),
    expiresIn: MFA_TOKEN_TTL_S,
  });
}

/** The user id of a valid MFA-pending token; throws jsonwebtoken errors otherwise. */
export function verifyMfaToken(token: string, config: Config): { userId: number; jti: string; exp: number } {
  const c = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof c === 'string' || c.typ !== MFA_TYP || !c.sub || !c.jti || !c.exp)
    throw new jwt.JsonWebTokenError('not an MFA token');
  return { userId: Number(c.sub), jti: c.jti, exp: c.exp };
}

export function revoke(db: Db, jti: string, exp: number) {
  db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, exp) VALUES (?, ?)').run(jti, exp);
}

export function isRevoked(db: Db, jti: string): boolean {
  return db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(jti) !== undefined;
}

/** Revocations only matter until the token would have expired anyway. */
export function purgeRevoked(db: Db, nowS = Math.floor(Date.now() / 1000)): number {
  return db.prepare('DELETE FROM revoked_tokens WHERE exp < ?').run(nowS).changes;
}
