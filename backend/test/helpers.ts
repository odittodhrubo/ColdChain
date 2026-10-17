import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/auth/tokens';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { createUser } from '../src/modules/users/service';
import type { Role } from '../src/rbac/permissions';
import { validEnv } from './env';

export const PASSWORD = 'Correct-Horse-9';

/** Fresh in-memory DB + app. bcrypt cost 10 keeps the suite fast; one test checks the real cost 12. */
export function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({ ...validEnv, BCRYPT_COST: '10', ...env });
  const db = openDb(':memory:');
  const app = createApp(config, db);
  return { app, db, config, http: () => request(app) };
}

export type TestApp = ReturnType<typeof makeApp>;

let n = 0;
export async function addUser(t: TestApp, role: Role, password = PASSWORD) {
  n += 1;
  return createUser(
    t.db,
    { email: `${role.toLowerCase()}${n}@test.local`, name: `${role} ${n}`, role, password },
    t.config.BCRYPT_COST,
  );
}

/** A valid session token without going through the rate-limited login route. */
export function tokenFor(t: TestApp, user: { id: number; role: Role; name: string }) {
  return signToken(user, t.config).token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
