import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, totpStep, verifyTotp } from '../src/auth/totp';
import { seed } from '../src/db/seed';
import { addUser, bearer, makeApp, PASSWORD, tokenFor } from './helpers';

const APP = 'http://localhost:5173'; // CORS_ORIGIN in tests
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('cc_session='));
const sessionCookie = (res: { headers: Record<string, unknown> }) => cookieOf(res)!.split(';')[0];
const nowCode = (secretB32: string, offsetSteps = 0) =>
  hotp(base32Decode(secretB32), totpStep(Date.now() / 1000) + offsetSteps);

describe('S1: browser sessions in an HttpOnly cookie', () => {
  it('login sets an HttpOnly SameSite=Strict cookie and keeps the token out of the body', async () => {
    const t = makeApp();
    const u = await addUser(t, 'PHARMACIST');
    const res = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined(); // nothing a script on the page could read
    expect(res.body).toMatchObject({
      user: { id: u.id },
      expiresAt: expect.any(Number),
      mustChangePassword: false,
    });
    const c = cookieOf(res)!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\//);
    expect(c).not.toMatch(/Secure/); // http://localhost in development
    const me = await t.http().get('/api/auth/me').set('Cookie', sessionCookie(res));
    expect(me.status).toBe(200);
  });

  it('marks the cookie Secure in production', async () => {
    const t = makeApp({ NODE_ENV: 'production' });
    const u = await addUser(t, 'INSPECTOR');
    const res = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(cookieOf(res)).toMatch(/Secure/);
  });

  it('refuses a cookie-authenticated write from another origin or with no origin at all (CSRF)', async () => {
    const t = makeApp();
    const u = await addUser(t, 'ADMIN');
    const login = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const cookie = sessionCookie(login);
    const body = { email: 'n1@test.local', name: 'N', role: 'INSPECTOR', password: 'Temp-Pass-1234' };
    const none = await t.http().post('/api/users').set('Cookie', cookie).send(body);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('CSRF_ORIGIN');
    const evil = await t
      .http()
      .post('/api/users')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(body);
    expect(evil.status).toBe(403);
    const ok = await t.http().post('/api/users').set('Cookie', cookie).set('Origin', APP).send(body);
    expect(ok.status).toBe(201);
    const read = await t.http().get('/api/users').set('Cookie', cookie); // reads need no origin
    expect(read.status).toBe(200);
    // Bearer is never sent by a browser on its own, so it needs no origin check
    const viaBearer = await t
      .http()
      .post('/api/users')
      .set(bearer(tokenFor(t, u)))
      .send({ ...body, email: 'n2@test.local' });
    expect(viaBearer.status).toBe(201);
  });

  it('logout clears the cookie and revokes the token', async () => {
    const t = makeApp();
    const u = await addUser(t, 'PHARMACIST');
    const login = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const cookie = sessionCookie(login);
    const out = await t.http().post('/api/auth/logout').set('Cookie', cookie).set('Origin', APP);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/cc_session=;|Expires=Thu, 01 Jan 1970/);
    expect((await t.http().get('/api/auth/me').set('Cookie', cookie)).body.error.code).toBe('TOKEN_REVOKED');
  });
});

describe('S2: password change', () => {
  it('needs the current password, a strong new one, and ends every older session', async () => {
    const t = makeApp();
    const u = await addUser(t, 'PHARMACIST');
    const other = tokenFor(t, u); // a second device
    const mine = tokenFor(t, u);
    const post = (token: string, body: object) =>
      t.http().post('/api/auth/password').set(bearer(token)).set('X-Auth-Mode', 'token').send(body);
    const wrong = await post(mine, { current: 'Wrong-Pass-123', next: 'Brand-New-Pass-42' });
    expect(wrong.status).toBe(400); // not 401: the session itself is fine
    expect(wrong.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect((await post(mine, { current: PASSWORD, next: 'short' })).status).toBe(400);
    expect((await post(mine, { current: PASSWORD, next: PASSWORD })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 1100)); // older tokens: issued in an earlier second
    const ok = await post(mine, { current: PASSWORD, next: 'Brand-New-Pass-42' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String)); // this session continues with a fresh token
    for (const old of [mine, other]) {
      const me = await t.http().get('/api/auth/me').set(bearer(old));
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('TOKEN_REVOKED');
    }
    expect((await t.http().get('/api/auth/me').set(bearer(ok.body.token))).status).toBe(200);
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({ email: u.email, password: 'Brand-New-Pass-42' });
    expect(login.status).toBe(200);
    const audited = t.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'USER_UPDATED'")
      .pluck()
      .all();
    expect(audited.join()).not.toContain('Brand-New-Pass-42');
  });

  it('a password an Admin set must be changed before anything else works', async () => {
    const t = makeApp();
    const admin = await addUser(t, 'ADMIN');
    const created = await t
      .http()
      .post('/api/users')
      .set(bearer(tokenFor(t, admin)))
      .send({ email: 'new@test.local', name: 'New', role: 'PHARMACIST', password: 'Temp-Pass-1234' });
    expect(created.status).toBe(201);
    const login = await t
      .http()
      .post('/api/auth/login')
      .set('X-Auth-Mode', 'token')
      .send({ email: 'new@test.local', password: 'Temp-Pass-1234' });
    expect(login.body.mustChangePassword).toBe(true);
    const token = login.body.token as string;
    const blocked = await t.http().get('/api/fridges').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await t.http().get('/api/auth/me').set(bearer(token))).body.mustChangePassword).toBe(true);
    const changed = await t
      .http()
      .post('/api/auth/password')
      .set(bearer(token))
      .set('X-Auth-Mode', 'token')
      .send({ current: 'Temp-Pass-1234', next: 'My-Own-Pass-77' });
    expect(changed.body.mustChangePassword).toBe(false);
    expect((await t.http().get('/api/fridges').set(bearer(changed.body.token))).status).toBe(200);
  });

  it("an Admin password reset ends the user's sessions and forces a change", async () => {
    const t = makeApp();
    const admin = await addUser(t, 'ADMIN');
    const u = await addUser(t, 'INSPECTOR');
    const before = tokenFor(t, u);
    await new Promise((r) => setTimeout(r, 1100));
    const reset = await t
      .http()
      .patch(`/api/users/${u.id}`)
      .set(bearer(tokenFor(t, admin)))
      .send({ password: 'Reset-Pass-1234' });
    expect(reset.status).toBe(200);
    expect((await t.http().get('/api/auth/me').set(bearer(before))).status).toBe(401);
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({ email: u.email, password: 'Reset-Pass-1234' });
    expect(login.body.mustChangePassword).toBe(true);
  });

  it('seeded accounts: a generated password must be changed, a given one (demo, tests) need not', async () => {
    const t = makeApp();
    await seed(t.db, t.config, { SEED_ADMIN_PASSWORD: 'Given-Admin-123' });
    const must = t.db.prepare('SELECT email, must_change_password AS m FROM users ORDER BY id').all();
    expect(must).toEqual([
      { email: 'admin@coldchain.local', m: 0 },
      { email: 'pharmacist@coldchain.local', m: 1 },
      { email: 'inspector@coldchain.local', m: 1 },
    ]);
  });
});

describe('S3: TOTP two-factor sign-in', () => {
  it('matches the RFC 6238 SHA-1 test vectors and round-trips base32', () => {
    const secret = Buffer.from('12345678901234567890');
    for (const [t, want] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ] as const)
      expect(hotp(secret, Math.floor(t / 30), 8)).toBe(want);
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(secret)).toBe(true);
    // ±1 step accepted, never a step at or below the last one used
    const step = totpStep(1_800_000_000);
    expect(verifyTotp(secret, hotp(secret, step + 1), 1_800_000_000, 0)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step + 2), 1_800_000_000, 0)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step), 1_800_000_000, step)).toBeNull();
  });

  it('setup, confirm, two-step login, no code reuse, one-time recovery codes, disable', async () => {
    const t = makeApp();
    const u = await addUser(t, 'ADMIN');
    const token = tokenFor(t, u);
    const setup = await t.http().post('/api/auth/totp/setup').set(bearer(token));
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(
      /^otpauth:\/\/totp\/ColdChain%3A.+\?secret=[A-Z2-7]+&issuer=ColdChain/,
    );
    const secret = setup.body.secret as string;
    const stored = t.db.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').pluck().get(u.id) as string;
    expect(stored).not.toContain(secret); // encrypted at rest
    expect(
      (await t.http().post('/api/auth/totp/confirm').set(bearer(token)).send({ code: '000000' })).status,
    ).toBe(400);
    const confirm = await t
      .http()
      .post('/api/auth/totp/confirm')
      .set(bearer(token))
      .send({ code: nowCode(secret) });
    expect(confirm.status).toBe(200);
    const codes = confirm.body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    // the password alone gives no session, only an MFA token
    const step1 = await t
      .http()
      .post('/api/auth/login')
      .set('X-Auth-Mode', 'token')
      .send({ email: u.email, password: PASSWORD });
    expect(step1.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(cookieOf(step1)).toBeUndefined();
    expect((await t.http().get('/api/auth/me').set(bearer(step1.body.mfaToken))).status).toBe(401); // not a session
    const wrong = await t
      .http()
      .post('/api/auth/totp/verify')
      .send({ mfaToken: step1.body.mfaToken, code: '123456' });
    expect(wrong.status).toBe(401);
    // the confirm used this step: a code from the next step signs in, once
    const code = nowCode(secret, 1);
    const step2 = await t
      .http()
      .post('/api/auth/totp/verify')
      .set('X-Auth-Mode', 'token')
      .send({ mfaToken: step1.body.mfaToken, code });
    expect(step2.status).toBe(200);
    expect(step2.body.token).toEqual(expect.any(String));
    const again = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const replay = await t.http().post('/api/auth/totp/verify').send({ mfaToken: again.body.mfaToken, code });
    expect(replay.status).toBe(401); // a code works once
    const used = await t
      .http()
      .post('/api/auth/totp/verify')
      .send({ mfaToken: step1.body.mfaToken, code: nowCode(secret, -1) });
    expect(used.status).toBe(401); // the MFA token itself is spent too

    // a recovery code signs in once
    const viaCode = await t
      .http()
      .post('/api/auth/totp/verify')
      .send({ mfaToken: again.body.mfaToken, recoveryCode: codes[0].toUpperCase() });
    expect(viaCode.status).toBe(200);
    const third = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(
      (
        await t
          .http()
          .post('/api/auth/totp/verify')
          .send({ mfaToken: third.body.mfaToken, recoveryCode: codes[0] })
      ).status,
    ).toBe(401);

    // switching it off needs a valid code
    t.db.prepare('UPDATE users SET totp_last_step = 0 WHERE id = ?').run(u.id);
    const off = await t
      .http()
      .post('/api/auth/totp/disable')
      .set(bearer(token))
      .send({ code: nowCode(secret) });
    expect(off.status).toBe(200);
    const plain = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(plain.body.mfaRequired).toBeUndefined();
  });

  it('REQUIRE_ADMIN_MFA: an Admin without TOTP can only set it up; other roles are unaffected', async () => {
    const t = makeApp({ REQUIRE_ADMIN_MFA: 'true' });
    const admin = await addUser(t, 'ADMIN');
    const token = tokenFor(t, admin);
    const blocked = await t.http().get('/api/users').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');
    const setup = await t.http().post('/api/auth/totp/setup').set(bearer(token));
    expect(setup.status).toBe(200);
    await t
      .http()
      .post('/api/auth/totp/confirm')
      .set(bearer(token))
      .send({ code: nowCode(setup.body.secret) });
    expect((await t.http().get('/api/users').set(bearer(token))).status).toBe(200);
    const pharm = await addUser(t, 'PHARMACIST');
    expect(
      (
        await t
          .http()
          .get('/api/fridges')
          .set(bearer(tokenFor(t, pharm)))
      ).status,
    ).toBe(200);
    // and an Admin cannot switch it off again here
    const off = await t
      .http()
      .post('/api/auth/totp/disable')
      .set(bearer(token))
      .send({ code: nowCode(setup.body.secret, 1) });
    expect(off.status).toBe(409);
  });

  it("an Admin can reset another user's TOTP (lost phone)", async () => {
    const t = makeApp();
    const admin = await addUser(t, 'ADMIN');
    const u = await addUser(t, 'PHARMACIST');
    const token = tokenFor(t, u);
    const setup = await t.http().post('/api/auth/totp/setup').set(bearer(token));
    await t
      .http()
      .post('/api/auth/totp/confirm')
      .set(bearer(token))
      .send({ code: nowCode(setup.body.secret) });
    const res = await t
      .http()
      .patch(`/api/users/${u.id}`)
      .set(bearer(tokenFor(t, admin)))
      .send({ totp_reset: true });
    expect(res.status).toBe(200);
    const login = await t.http().post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(login.body.mfaRequired).toBeUndefined();
    expect(t.db.prepare('SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ?').pluck().get(u.id)).toBe(
      0,
    );
  });
});
