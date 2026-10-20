import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import { createUser, requirePasswordChange } from '../modules/users/service';
import type { Role } from '../rbac/permissions';
import { decryptSecret, encryptSecret } from '../shared/secretbox';
import type { Db } from './index';

export const SEED_USERS: { email: string; name: string; role: Role; env: string }[] = [
  { email: 'admin@coldchain.local', name: 'Admin', role: 'ADMIN', env: 'SEED_ADMIN_PASSWORD' },
  {
    email: 'pharmacist@coldchain.local',
    name: 'Pharmacist',
    role: 'PHARMACIST',
    env: 'SEED_PHARMACIST_PASSWORD',
  },
  {
    email: 'inspector@coldchain.local',
    name: 'Inspector',
    role: 'INSPECTOR',
    env: 'SEED_INSPECTOR_PASSWORD',
  },
];

export const SEED_FRIDGES = [
  { id: 'fridge-01', name: 'Vaccine Fridge A', capacity: 20, device: 'fridge-01' },
  { id: 'fridge-02', name: 'Vaccine Fridge B', capacity: 20, device: 'fridge-02' },
];

const secretVar = (deviceId: string) => `DEVICE_SECRET_${deviceId.replace(/-/g, '_').toUpperCase()}`;

/** Random, policy-compliant (length + all four character classes). */
const randomPassword = () => `${randomBytes(12).toString('base64url')}Aa9!`;

export interface SeedResult {
  users: { email: string; role: Role; password?: string }[]; // password only when created now
  devices: { deviceId: string; secret?: string; source: 'env' | 'generated' | 'existing' }[];
}

/** Idempotent: existing users keep their passwords; devices pick up DEVICE_SECRET_* from env when set. */
export async function seed(
  db: Db,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const result: SeedResult = { users: [], devices: [] };
  for (const u of SEED_USERS) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) {
      result.users.push({ email: u.email, role: u.role });
      continue;
    }
    const given = env[u.env];
    const password = given || randomPassword();
    const created = await createUser(
      db,
      { email: u.email, name: u.name, role: u.role, password },
      config.BCRYPT_COST,
    );
    // a generated password is printed once on a console: it must be replaced at first sign-in (S2). One given
    // through SEED_*_PASSWORD (make demo, the e2e and scenario stacks) was chosen on purpose and stays.
    if (!given) requirePasswordChange(db, created.id);
    result.users.push({ email: u.email, role: u.role, password });
  }

  const now = Date.now();
  for (const f of SEED_FRIDGES) {
    db.prepare(
      `INSERT INTO fridges (id, name, capacity, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, capacity = excluded.capacity`,
    ).run(f.id, f.name, f.capacity, now);

    const fromEnv = env[secretVar(f.device)];
    const existing = db.prepare('SELECT secret_enc FROM devices WHERE device_id = ?').get(f.device) as
      { secret_enc: string } | undefined;
    if (existing && (!fromEnv || decryptSecret(existing.secret_enc, config.APP_SECRET_KEY) === fromEnv)) {
      result.devices.push({ deviceId: f.device, source: 'existing' });
      continue;
    }
    const secret = /^[0-9a-f]{64}$/i.test(fromEnv ?? '') ? fromEnv! : randomBytes(32).toString('hex');
    db.prepare(
      `INSERT INTO devices (device_id, fridge_id, secret_enc, active, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(device_id) DO UPDATE SET secret_enc = excluded.secret_enc, fridge_id = excluded.fridge_id,
         pending_secret_enc = NULL`, // re-provisioning (S7 recovery) cancels a rotation that never completed
    ).run(f.device, f.id, encryptSecret(secret, config.APP_SECRET_KEY), now);
    result.devices.push({ deviceId: f.device, secret, source: secret === fromEnv ? 'env' : 'generated' });
  }
  return result;
}
