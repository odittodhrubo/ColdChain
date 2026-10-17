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
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, email, name, role, active, created_at, updated_at';
const toUser = (row: Omit<User, 'active'> & { active: number }): User => ({
  ...row,
  active: row.active === 1,
});

export function listUsers(db: Db): User[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY id`).all() as Parameters<typeof toUser>[0][]).map(
    toUser,
  );
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
  patch: { name?: string; role?: Role; active?: boolean; password?: string },
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
  })();
  return getUser(db, id);
}
