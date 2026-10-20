import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { seed } from '../src/db/seed';
import { decryptSecret } from '../src/shared/secretbox';
import { validEnv } from './env';
import { addUser, bearer, makeApp, tokenFor } from './helpers';

async function adminApp() {
  const t = makeApp();
  const admin = await addUser(t, 'ADMIN');
  return { t, admin, auth: bearer(tokenFor(t, admin)) };
}

describe('users (admin)', () => {
  it('creates users without ever returning the hash, and rejects duplicates and weak passwords', async () => {
    const { t, auth } = await adminApp();
    const body = { email: 'nurse@test.local', name: 'Nurse', role: 'PHARMACIST', password: 'Strong-Pass-42' };
    const res = await t.http().post('/api/users').set(auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'nurse@test.local', role: 'PHARMACIST', active: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2b\$/);
    expect(
      (
        await t
          .http()
          .post('/api/users')
          .set(auth)
          .send({ ...body, email: 'NURSE@test.local' })
      ).body.error.code,
    ).toBe('EMAIL_TAKEN');
    for (const password of ['short1A!', 'alllowercaseletters', 'abcdefghij1']) {
      const weak = await t
        .http()
        .post('/api/users')
        .set(auth)
        .send({ ...body, email: 'w@test.local', password });
      expect(weak.status, password).toBe(400);
    }
  });

  it('rejects unknown fields (no mass assignment)', async () => {
    const { t, auth } = await adminApp();
    const target = await addUser(t, 'INSPECTOR');
    for (const extra of [{ password_hash: 'x' }, { id: 1 }, { email: 'other@test.local' }]) {
      const res = await t
        .http()
        .patch(`/api/users/${target.id}`)
        .set(auth)
        .send({ name: 'n', ...extra });
      expect(res.status).toBe(400);
    }
    expect((await t.http().patch(`/api/users/${target.id}`).set(auth).send({})).status).toBe(400);
    expect((await t.http().get('/api/users?role=ADMIN').set(auth)).status).toBe(400); // unknown query too
  });

  it('changes role, resets password, disables', async () => {
    const { t, auth } = await adminApp();
    const target = await addUser(t, 'INSPECTOR');
    const promoted = await t
      .http()
      .patch(`/api/users/${target.id}`)
      .set(auth)
      .send({ role: 'PHARMACIST', password: 'Fresh-Pass-123' });
    expect(promoted.body.user.role).toBe('PHARMACIST');
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({ email: target.email, password: 'Fresh-Pass-123' });
    expect(login.status).toBe(200);
    const disabled = await t.http().delete(`/api/users/${target.id}`).set(auth);
    expect(disabled.body.user.active).toBe(false);
    expect((await t.http().get('/api/auth/me').set(bearer(login.body.token))).status).toBe(401);
    expect((await t.http().patch('/api/users/9999').set(auth).send({ name: 'x' })).status).toBe(404);
  });

  it('never removes the last active admin', async () => {
    const { t, admin, auth } = await adminApp();
    for (const req of [
      t.http().delete(`/api/users/${admin.id}`).set(auth),
      t.http().patch(`/api/users/${admin.id}`).set(auth).send({ role: 'PHARMACIST' }),
      t.http().patch(`/api/users/${admin.id}`).set(auth).send({ active: false }),
    ]) {
      const res = await req;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    }
    const second = await addUser(t, 'ADMIN');
    expect(
      (
        await t
          .http()
          .delete(`/api/users/${admin.id}`)
          .set(bearer(tokenFor(t, second)))
      ).status,
    ).toBe(200);
    // second is now the last one
    expect(
      (
        await t
          .http()
          .delete(`/api/users/${second.id}`)
          .set(bearer(tokenFor(t, second)))
      ).status,
    ).toBe(409);
  });
});

describe('display tokens (P1)', () => {
  it('creates a 30-day read-only token, keeps displays out of the people list, and revokes', async () => {
    const { t, auth } = await adminApp();
    const res = await t.http().post('/api/displays').set(auth).send({ label: 'Pharmacy wall screen' });
    expect(res.status).toBe(201);
    expect(res.body.display).toMatchObject({ label: 'Pharmacy wall screen', active: true });
    expect(res.body.url).toContain('/display#token=');
    // Long-lived: still valid well past a day (a wall screen must not log out overnight).
    expect(res.body.expiresAt * 1000 - Date.now()).toBeGreaterThan(24 * 3600_000);

    const display = bearer(res.body.token);
    expect((await t.http().get('/api/alerts?status=all').set(display)).status).toBe(200); // reads: ok
    expect((await t.http().post('/api/users').set(display).send({})).status).toBe(403); // writes: refused
    expect((await t.http().get('/api/users').set(auth)).body.users.some((u: { role: string }) => u.role === 'DISPLAY')).toBe(false);

    const id = res.body.display.id;
    expect((await t.http().post(`/api/displays/${id}/revoke`).set(auth)).body.display.active).toBe(false);
    // Revoked: the (still-unexpired) token no longer authenticates.
    expect((await t.http().get('/api/alerts?status=all').set(display)).status).toBe(401);
    expect((await t.http().get('/api/displays').set(auth)).body.displays).toHaveLength(1);
  });
});

describe('seed', () => {
  it('creates 3 users, 2 fridges, 2 devices with encrypted secrets, and is idempotent', async () => {
    const config = loadConfig({ ...validEnv, BCRYPT_COST: '10' });
    const db = openDb(':memory:');
    const envSecret = 'f'.repeat(64);
    const first = await seed(db, config, {
      DEVICE_SECRET_FRIDGE_01: envSecret,
      SEED_ADMIN_PASSWORD: 'Admin-Pass-2026',
    });
    expect(first.users.map((u) => [u.email, u.role])).toEqual([
      ['admin@coldchain.local', 'ADMIN'],
      ['pharmacist@coldchain.local', 'PHARMACIST'],
      ['inspector@coldchain.local', 'INSPECTOR'],
    ]);
    expect(first.users[0].password).toBe('Admin-Pass-2026');
    expect(first.users[1].password).toMatch(/.{10,}/);
    expect(db.prepare('SELECT id, name, capacity FROM fridges ORDER BY id').all()).toEqual([
      { id: 'fridge-01', name: 'Vaccine Fridge A', capacity: 20 },
      { id: 'fridge-02', name: 'Vaccine Fridge B', capacity: 20 },
    ]);
    expect(first.devices).toEqual([
      { deviceId: 'fridge-01', secret: envSecret, source: 'env' },
      { deviceId: 'fridge-02', secret: expect.stringMatching(/^[0-9a-f]{64}$/), source: 'generated' },
    ]);
    const rows = db.prepare('SELECT device_id, secret_enc FROM devices ORDER BY device_id').all() as {
      device_id: string;
      secret_enc: string;
    }[];
    for (const [i, row] of rows.entries()) {
      expect(row.secret_enc).not.toContain(first.devices[i].secret!); // encrypted at rest
      expect(decryptSecret(row.secret_enc, config.APP_SECRET_KEY)).toBe(first.devices[i].secret);
    }
    expect(db.prepare('SELECT password_hash FROM users').pluck().all()).toEqual(
      Array(3).fill(expect.stringMatching(/^\$2b\$10\$/)),
    );

    const again = await seed(db, config, { DEVICE_SECRET_FRIDGE_01: envSecret });
    expect(again.users.every((u) => u.password === undefined)).toBe(true);
    expect(again.devices.map((d) => d.source)).toEqual(['existing', 'existing']);
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(3);
  });
});
