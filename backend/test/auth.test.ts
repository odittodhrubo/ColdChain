import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_LIMIT_PER_MIN, MAX_FAILURES } from '../src/auth/routes';
import { addUser, bearer, makeApp, PASSWORD, tokenFor } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('login', () => {
  it('returns a HS256 JWT with sub, role, name and jti for valid credentials', async () => {
    const t = makeApp();
    const user = await addUser(t, 'PHARMACIST');
    const res = await t
      .http()
      .post('/api/auth/login')
      .send({ email: user.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: user.id, email: user.email, name: user.name, role: 'PHARMACIST' });
    const decoded = jwt.decode(res.body.token, { complete: true })!;
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload).toMatchObject({
      sub: String(user.id),
      role: 'PHARMACIST',
      name: user.name,
      jti: expect.any(String),
    });
    const me = await t.http().get('/api/auth/me').set(bearer(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it('gives the same generic error for a wrong password and an unknown email, and runs bcrypt for both', async () => {
    const t = makeApp();
    const user = await addUser(t, 'ADMIN');
    const compare = vi.spyOn(bcrypt, 'compare');
    const wrong = await t
      .http()
      .post('/api/auth/login')
      .send({ email: user.email, password: 'nope-nope-nope' });
    const unknown = await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'ghost@test.local', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    expect(compare).toHaveBeenCalledTimes(2); // dummy-hash compare for the unknown email: no timing oracle
  });

  it('rejects disabled accounts with the generic error', async () => {
    const t = makeApp();
    const user = await addUser(t, 'INSPECTOR');
    t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    const res = await t.http().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks an account after 5 failures, even for the right password, and unlocks after the backoff', async () => {
    const t = makeApp();
    const user = await addUser(t, 'ADMIN');
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(
        (await t.http().post('/api/auth/login').send({ email: user.email, password: 'bad-password-1' }))
          .status,
      ).toBe(401);
    }
    const locked = await t.http().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    t.db.prepare('UPDATE login_attempts SET locked_until = 0').run(); // backoff elapsed
    expect(
      (await t.http().post('/api/auth/login').send({ email: user.email, password: PASSWORD })).status,
    ).toBe(200);
    expect(t.db.prepare('SELECT COUNT(*) FROM login_attempts').pluck().get()).toBe(0); // success clears the counter
  });

  it('rate-limits login per IP', async () => {
    const t = makeApp();
    const statuses = [];
    for (let i = 0; i <= LOGIN_LIMIT_PER_MIN; i++) {
      statuses.push(
        (
          await t
            .http()
            .post('/api/auth/login')
            .send({ email: `x${i}@test.local`, password: 'whatever-1' })
        ).status,
      );
    }
    expect(statuses.slice(0, LOGIN_LIMIT_PER_MIN).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('stores bcrypt hashes with cost 12', async () => {
    const t = makeApp({ BCRYPT_COST: '12' });
    const user = await addUser(t, 'ADMIN');
    const hash = t.db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(user.id) as string;
    expect(hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  });
});

describe('tokens', () => {
  it('logout revokes the token on the server', async () => {
    const t = makeApp();
    const token = tokenFor(t, await addUser(t, 'INSPECTOR'));
    expect((await t.http().post('/api/auth/logout').set(bearer(token))).status).toBe(204);
    const after = await t.http().get('/api/auth/me').set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('rejects expired, tampered, wrongly signed and alg=none tokens', async () => {
    const t = makeApp();
    const user = await addUser(t, 'ADMIN');
    const sign = (payload: object, secret = t.config.JWT_SECRET, opts: jwt.SignOptions = {}) =>
      jwt.sign({ role: 'ADMIN', name: 'x', ...payload }, secret, {
        subject: String(user.id),
        jwtid: 'j1',
        ...opts,
      });

    const expired = sign({ exp: Math.floor(Date.now() / 1000) - 10 });
    const res = await t.http().get('/api/auth/me').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');

    const [h, p, s] = tokenFor(t, user).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: '999' }),
    ).toString('base64url');
    const tampered = [h, forgedPayload, s].join('.');
    const otherKey = sign({}, 'y'.repeat(48), { expiresIn: 60 });
    const none = [Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), p, ''].join('.');
    for (const bad of [tampered, otherKey, none, 'not-a-token']) {
      const r = await t.http().get('/api/auth/me').set(bearer(bad));
      expect(r.status).toBe(401);
    }
  });

  it('re-reads the role from the DB: a demoted user loses access at once', async () => {
    const t = makeApp();
    const admin = await addUser(t, 'ADMIN');
    await addUser(t, 'ADMIN'); // keep another admin so the demotion is allowed
    const token = tokenFor(t, admin);
    expect((await t.http().get('/api/users').set(bearer(token))).status).toBe(200);
    t.db.prepare("UPDATE users SET role = 'INSPECTOR' WHERE id = ?").run(admin.id);
    expect((await t.http().get('/api/users').set(bearer(token))).status).toBe(403); // token still says ADMIN
    t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(admin.id);
    expect((await t.http().get('/api/auth/me').set(bearer(token))).status).toBe(401);
  });
});
