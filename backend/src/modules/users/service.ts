import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../../auth/password';
import type { Db } from '../../db';
import { conflict, notFound } from '../../shared/errors';
import type { Role } from '../../rbac/permissions';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  totp_enabled: boolean; // two-factor on (never the secret)
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, email, name, role, active, totp_enabled, created_at, updated_at';
type UserRow = Omit<User, 'active' | 'totp_enabled'> & { active: number; totp_enabled: number };
const toUser = (row: UserRow): User => ({
  ...row,
  active: row.active === 1,
  totp_enabled: row.totp_enabled === 1,
});

/** Staff only. Display tokens (role DISPLAY, P1) are managed separately and never shown in the people list. */
export function listUsers(db: Db): User[] {
  return (
    db.prepare(`SELECT ${COLUMNS} FROM users WHERE role != 'DISPLAY' ORDER BY id`).all() as Parameters<
      typeof toUser
    >[0][]
  ).map(toUser);
}

export function getUser(db: Db, id: number): User {
  const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as
    Parameters<typeof toUser>[0] | undefined;
  if (!row) throw notFound('User not found');
  return toUser(row);
}

export async function createUser(
  db: Db,
  input: { email: string; name: string; role: Role; password: string },
  cost: number,
): Promise<User> {
  const hash = await hashPassword(input.password, cost);
  const now = Date.now();
  try {
    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO users (email, name, role, password_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      )
      .run(input.email.toLowerCase(), input.name, input.role, hash, now, now);
    return getUser(db, Number(lastInsertRowid));
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
      throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
    throw err;
  }
}

/** Rejects a change that would leave no active admin. */
function assertKeepsAnAdmin(db: Db, target: User, next: { role: Role; active: boolean }) {
  const losesAdmin = target.role === 'ADMIN' && target.active && (next.role !== 'ADMIN' || !next.active);
  if (!losesAdmin) return;
  const others = db
    .prepare("SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND active = 1 AND id != ?")
    .pluck()
    .get(target.id) as number;
  if (others === 0) throw conflict('LAST_ADMIN', 'The last active admin cannot be disabled or demoted');
}

export async function updateUser(
  db: Db,
  id: number,
  patch: { name?: string; role?: Role; active?: boolean; password?: string; totp_reset?: boolean },
  cost: number,
): Promise<User> {
  const user = getUser(db, id);
  const next = { role: patch.role ?? user.role, active: patch.active ?? user.active };
  assertKeepsAnAdmin(db, user, next);
  const hash = patch.password ? await hashPassword(patch.password, cost) : undefined;
  db.transaction(() => {
    assertKeepsAnAdmin(db, getUser(db, id), next); // re-check inside the write: two admins demoting each other
    db.prepare(
      `UPDATE users SET name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
    ).run(patch.name ?? user.name, next.role, next.active ? 1 : 0, hash ?? null, Date.now(), id);
    // S2: a password an Admin set is temporary: the user must choose their own, and older sessions end
    if (hash)
      db.prepare('UPDATE users SET must_change_password = 1, password_changed_at = ? WHERE id = ?').run(
        Math.floor(Date.now() / 1000),
        id,
      );
    // S3: lost phone and no recovery codes left: an Admin switches two-factor off; the user sets it up again
    if (patch.totp_reset) {
      db.prepare(
        'UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?',
      ).run(id);
      db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(id);
    }
  })();
  return getUser(db, id);
}

/** A new account: a password from someone else (Admin, generated seed) must be changed at first sign-in. */
export function requirePasswordChange(db: Db, id: number) {
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- display tokens (P1)

export interface Display {
  id: number;
  label: string; // the display's name, e.g. "Pharmacy wall screen"
  active: boolean;
  created_at: number;
}

const toDisplay = (r: { id: number; name: string; active: number; created_at: number }): Display => ({
  id: r.id,
  label: r.name,
  active: r.active === 1,
  created_at: r.created_at,
});

/** A read-only wall-display principal: a password-less DISPLAY users row. The caller signs its long-lived token. */
export async function createDisplay(db: Db, label: string, cost: number): Promise<Display> {
  // No one ever signs in as a display, so the password is random and thrown away; the row just needs a valid hash.
  const hash = await hashPassword(randomBytes(24).toString('base64'), cost);
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (email, name, role, password_hash, active, created_at, updated_at)
       VALUES (?, ?, 'DISPLAY', ?, 1, ?, ?)`,
    )
    .run(`display-${randomUUID()}@display.local`, label, hash, now, now);
  return getDisplay(db, Number(lastInsertRowid));
}

export function getDisplay(db: Db, id: number): Display {
  const row = db
    .prepare("SELECT id, name, active, created_at FROM users WHERE id = ? AND role = 'DISPLAY'")
    .get(id) as Parameters<typeof toDisplay>[0] | undefined;
  if (!row) throw notFound('Display not found');
  return toDisplay(row);
}

export function listDisplays(db: Db): Display[] {
  return (
    db
      .prepare("SELECT id, name, active, created_at FROM users WHERE role = 'DISPLAY' ORDER BY id")
      .all() as Parameters<typeof toDisplay>[0][]
  ).map(toDisplay);
}

/** Revoking is permanent: the token keeps verifying until it expires, but the disabled row makes it unusable. */
export function revokeDisplay(db: Db, id: number): Display {
  getDisplay(db, id); // 404 if it is not a display
  db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  return getDisplay(db, id);
}
