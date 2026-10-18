import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import {
  type BatchInput,
  createBatch,
  getBatch,
  moveBatch,
  newPublicToken,
  refreshStatus,
} from '../src/modules/batches/service';
import { RecordingRealtime } from '../src/realtime';
import type { AppContext } from '../src/shared/http';
import { deriveBatchStatus, remainingPct, utcToday } from '../src/shared/status';
import { addFridge, addUser, batchInput, bearer, makeApp, tokenFor, type TestApp } from './helpers';

const ctxOf = (t: TestApp) => t.app.locals.ctx as AppContext;
const mk = (t: TestApp, fridgeId: string, over: Record<string, unknown> = {}) =>
  createBatch(ctxOf(t), batchInput(fridgeId, over) as BatchInput);

async function asRole(t: TestApp, role: 'ADMIN' | 'PHARMACIST' | 'INSPECTOR') {
  return bearer(tokenFor(t, await addUser(t, role)));
}

const setExposure = (t: TestApp, id: number, s: number) =>
  t.db.prepare('UPDATE batches SET exposure_ms = ? WHERE id = ?').run(s * 1000, id);

const openAssignments = (t: TestApp, id: number) =>
  t.db
    .prepare('SELECT fridge_id FROM batch_assignments WHERE batch_id = ? AND to_ts IS NULL')
    .pluck()
    .all(id);

describe('batch status derivation (contract section 2)', () => {
  const today = '2026-06-15';
  it('SAFE, AT_RISK below 20 %, DISCARD at 0 %, when expired, or once discarded', () => {
    expect(deriveBatchStatus(100, '2027-01-01', false, today)).toBe('SAFE');
    expect(deriveBatchStatus(20, '2027-01-01', false, today)).toBe('SAFE');
    expect(deriveBatchStatus(19.99, '2027-01-01', false, today)).toBe('AT_RISK');
    expect(deriveBatchStatus(0, '2027-01-01', false, today)).toBe('DISCARD');
    expect(deriveBatchStatus(100, '2026-06-14', false, today)).toBe('DISCARD'); // expired yesterday
    expect(deriveBatchStatus(100, today, false, today)).toBe('SAFE'); // expires today: usable today
    expect(deriveBatchStatus(100, '2027-01-01', true, today)).toBe('DISCARD');
  });

  it('remaining budget from weighted seconds, expiry as UTC dates', () => {
    expect(remainingPct(0)).toBe(100);
    expect(remainingPct(2880)).toBeCloseTo(20);
    expect(remainingPct(5000)).toBe(0);
    expect(utcToday(Date.UTC(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });
});

describe('batches API', () => {
  it('creates, lists with filters, shows detail with history', async () => {
    const t = makeApp();
    const [a, b] = [addFridge(t), addFridge(t)];
    const auth = await asRole(t, 'PHARMACIST');
    const created = await t
      .http()
      .post('/api/batches')
      .set(auth)
      .send(batchInput(a, { name: 'Insulin glargine' }));
    expect(created.status).toBe(201);
    expect(created.body.batch).toMatchObject({
      fridge_id: a,
      status: 'SAFE',
      remaining_pct: 100,
      quantity: 50,
    });
    expect(created.body.batch.public_token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const soon = utcToday(Date.now() + 5 * 86_400_000);
    await t
      .http()
      .post('/api/batches')
      .set(auth)
      .send(batchInput(b, { expiry_date: soon }));

    const list = async (q: string) => (await t.http().get(`/api/batches${q}`).set(auth)).body;
    expect((await list(`?fridge_id=${a}`)).batches.map((x: { name: string }) => x.name)).toEqual([
      'Insulin glargine',
    ]);
    expect((await list('?q=insulin')).total).toBe(1);
    expect((await list('?expiring_within_days=10')).batches[0].fridge_id).toBe(b);
    expect((await list('?q=%25')).total).toBe(0); // LIKE wildcards are escaped
    expect((await list('?status=SAFE')).total).toBe(2);
    expect((await list('?pageSize=1&page=2')).batches).toHaveLength(1);

    const detail = await t.http().get(`/api/batches/${created.body.batch.id}`).set(auth);
    expect(detail.body.assignments).toEqual([expect.objectContaining({ fridge_id: a, to_ts: null })]);
    expect(detail.body.exposure).toMatchObject({ remaining_pct: 100, used_minutes: 0, budget_s: 3600 });
  });

  it('validates input: future expiry, known fridge, no unknown fields', async () => {
    const t = makeApp();
    const a = addFridge(t);
    const auth = await asRole(t, 'ADMIN');
    const post = (body: object) => t.http().post('/api/batches').set(auth).send(body);
    expect((await post(batchInput(a, { expiry_date: utcToday() }))).status).toBe(400);
    expect((await post(batchInput(a, { expiry_date: '2026-13-01' }))).status).toBe(400);
    expect((await post(batchInput('nope'))).status).toBe(404);
    expect((await post({ ...batchInput(a), status: 'SAFE' })).status).toBe(400); // no mass assignment
    expect((await post(batchInput(a, { criticality: 4 }))).status).toBe(400);
    expect((await post(batchInput(a, { quantity: 0 }))).status).toBe(400);
  });

  it('enforces fridge capacity on create and move', async () => {
    const t = makeApp();
    const small = addFridge(t, 2);
    const other = addFridge(t);
    const auth = await asRole(t, 'PHARMACIST');
    const post = (f: string) => t.http().post('/api/batches').set(auth).send(batchInput(f));
    expect((await post(small)).status).toBe(201);
    expect((await post(small)).status).toBe(201);
    const full = await post(small);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('FRIDGE_FULL');
    const outside = (await post(other)).body.batch;
    const move = await t
      .http()
      .post(`/api/batches/${outside.id}/move`)
      .set(auth)
      .send({ to_fridge_id: small });
    expect(move.status).toBe(409);
    expect(openAssignments(t, outside.id)).toEqual([other]);
  });

  it('moves a batch: closes one interval, opens the next, audits, keeps its exposure', async () => {
    const t = makeApp();
    const rt = new RecordingRealtime();
    ctxOf(t).realtime = rt;
    const [a, b] = [addFridge(t), addFridge(t)];
    const auth = await asRole(t, 'PHARMACIST');
    const batch = mk(t, a);
    setExposure(t, batch.id, 600);
    const res = await t.http().post(`/api/batches/${batch.id}/move`).set(auth).send({ to_fridge_id: b });
    expect(res.status).toBe(200);
    expect(res.body.batch).toMatchObject({ fridge_id: b, weighted_exposure_s: 600 });
    const history = t.db
      .prepare('SELECT fridge_id, from_ts, to_ts FROM batch_assignments WHERE batch_id = ? ORDER BY id')
      .all(batch.id) as { fridge_id: string; from_ts: number; to_ts: number | null }[];
    expect(history.map((h) => h.fridge_id)).toEqual([a, b]);
    expect(history[0].to_ts).toBe(history[1].from_ts); // no gap, no overlap
    expect(history[1].to_ts).toBeNull();
    const audit = t.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'BATCH_MOVED'")
      .pluck()
      .get() as string;
    expect(JSON.parse(audit)).toEqual({ batch_id: batch.id, from: a, to: b });
    expect(rt.of('batch:update').at(-1)).toMatchObject({ id: batch.id, fridge_id: b });
    const again = await t.http().post(`/api/batches/${batch.id}/move`).set(auth).send({ to_fridge_id: b });
    expect(again.body.error.code).toBe('SAME_FRIDGE');
  });

  it('a failure in the middle of a move leaves the batch where it was (atomic)', () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const [a, b] = [addFridge(t), addFridge(t)];
    const batch = mk(t, a);
    const spy = vi.spyOn(ctx.audit, 'append').mockImplementation(() => {
      throw new Error('disk full'); // after both assignment writes, before the commit
    });
    expect(() => moveBatch(ctx, batch.id, b)).toThrow('disk full');
    spy.mockRestore();
    expect(openAssignments(t, batch.id)).toEqual([a]);
    expect(
      t.db.prepare('SELECT COUNT(*) FROM batch_assignments WHERE batch_id = ?').pluck().get(batch.id),
    ).toBe(1);
    expect(getBatch(t.db, batch.id).fridge_id).toBe(a);
  });

  it('a DISCARD batch cannot move and stays DISCARD (out of budget or expired)', async () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const [a, b] = [addFridge(t), addFridge(t)];
    const auth = await asRole(t, 'ADMIN');
    const hot = mk(t, a);
    setExposure(t, hot.id, 3600);
    expect(refreshStatus(ctx, hot.id)).toBe('DISCARD');
    const res = await t.http().post(`/api/batches/${hot.id}/move`).set(auth).send({ to_fridge_id: b });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_DISCARDED');
    setExposure(t, hot.id, 0); // exposure never decreases; even if a row were edited, discard is permanent
    expect(refreshStatus(ctx, hot.id)).toBe('DISCARD');
    const edit = await t.http().patch(`/api/batches/${hot.id}`).set(auth).send({ expiry_date: '2099-01-01' });
    expect(edit.body.batch.status).toBe('DISCARD');

    const old = mk(t, a);
    t.db.prepare("UPDATE batches SET expiry_date = '2020-01-01' WHERE id = ?").run(old.id);
    expect(
      (await t.http().post(`/api/batches/${old.id}/move`).set(auth).send({ to_fridge_id: b })).status,
    ).toBe(409);
  });

  it('status changes are audited, pushed and handed to the alert hook exactly once', () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const rt = new RecordingRealtime();
    ctx.realtime = rt;
    const hook = vi.fn();
    ctx.hooks.batchStatusChanged = hook;
    const batch = mk(t, addFridge(t));
    setExposure(t, batch.id, 3000); // 16.7 % left
    expect(refreshStatus(ctx, batch.id)).toBe('AT_RISK');
    expect(refreshStatus(ctx, batch.id)).toBe('AT_RISK'); // no change: nothing fires again
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0].slice(1)).toEqual(['SAFE', 'AT_RISK']);
    const changes = t.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'BATCH_STATUS_CHANGED'")
      .pluck()
      .all() as string[];
    expect(changes.map((p) => JSON.parse(p))).toEqual([
      expect.objectContaining({ batch_id: batch.id, from: 'SAFE', to: 'AT_RISK' }),
    ]);
    expect(rt.of('batch:update').at(-1)).toMatchObject({ id: batch.id, status: 'AT_RISK' });
  });

  it('soft delete: Admin only, quantity 0 only, frees the fridge slot', async () => {
    const t = makeApp();
    const f = addFridge(t, 1);
    const batch = mk(t, f);
    const admin = await asRole(t, 'ADMIN');
    const del = () => t.http().delete(`/api/batches/${batch.id}`);
    expect((await del().set(admin)).body.error.code).toBe('QUANTITY_NOT_ZERO');
    expect((await del().set(await asRole(t, 'PHARMACIST'))).status).toBe(403);
    await t.http().patch(`/api/batches/${batch.id}`).set(admin).send({ quantity: 0 });
    expect((await del().set(admin)).status).toBe(200);
    expect((await t.http().get(`/api/batches/${batch.id}`).set(admin)).status).toBe(404);
    expect(mk(t, f).fridge_id).toBe(f); // the slot is free again
  });

  it('Inspector is read-only', async () => {
    const t = makeApp();
    const f = addFridge(t);
    const batch = mk(t, f);
    const auth = await asRole(t, 'INSPECTOR');
    expect((await t.http().get('/api/batches').set(auth)).status).toBe(200);
    expect((await t.http().get(`/api/batches/${batch.id}/qr`).set(auth)).status).toBe(200);
    expect((await t.http().post('/api/batches').set(auth).send(batchInput(f))).status).toBe(403);
    expect((await t.http().patch(`/api/batches/${batch.id}`).set(auth).send({ quantity: 1 })).status).toBe(
      403,
    );
    const move = await t.http().post(`/api/batches/${batch.id}/move`).set(auth).send({ to_fridge_id: f });
    expect(move.status).toBe(403);
  });
});

describe('QR code', () => {
  it('PNG decodes to the public check URL', async () => {
    const t = makeApp({ PUBLIC_BASE_URL: 'https://coldchain.example/' });
    const batch = mk(t, addFridge(t));
    const res = await t
      .http()
      .get(`/api/batches/${batch.id}/qr?format=png`)
      .set(await asRole(t, 'INSPECTOR'))
      .buffer(true);
    expect(res.headers['content-type']).toBe('image/png');
    const png = PNG.sync.read(res.body as Buffer);
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(code?.data).toBe(`https://coldchain.example/check/${batch.public_token}`);
  });

  it('SVG carries the batch name and lot as an escaped caption', async () => {
    const t = makeApp();
    const batch = mk(t, addFridge(t), { name: 'MMR <live> & co', lot_number: 'L-77' });
    const res = await t
      .http()
      .get(`/api/batches/${batch.id}/qr`)
      .set(await asRole(t, 'PHARMACIST'))
      .buffer(true);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    const svg = String(res.body);
    expect(svg).toContain('MMR &lt;live&gt; &amp; co');
    expect(svg).toContain('Lot L-77');
    expect(svg).not.toContain('<live>');
  });
});

describe('public QR check endpoint', () => {
  it('needs no login, returns whitelisted fields only, is never cached', async () => {
    const t = makeApp();
    const batch = mk(t, addFridge(t), { expiry_date: '2099-01-31' });
    const res = await t.http().get(`/api/public/batch/${batch.public_token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'expired',
      'expiry_date',
      'last_checked',
      'lot_number',
      'name',
      'status',
    ]);
    expect(res.body).toMatchObject({
      name: batch.name,
      status: 'SAFE',
      expired: false,
      expiry_date: '2099-01-31',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const raw = JSON.stringify(res.body);
    for (const leak of [batch.fridge_id!, 'weighted', 'created_by', 'Test Fridge', 'Acme'])
      expect(raw).not.toContain(leak);
  });

  it('shows Safe / At Risk / Discard, and Discard once expired', async () => {
    const t = makeApp();
    const batch = mk(t, addFridge(t));
    const check = async () => (await t.http().get(`/api/public/batch/${batch.public_token}`)).body;
    setExposure(t, batch.id, 3000);
    expect((await check()).status).toBe('AT_RISK');
    setExposure(t, batch.id, 3600);
    expect((await check()).status).toBe('DISCARD');
    setExposure(t, batch.id, 0);
    t.db.prepare("UPDATE batches SET expiry_date = '2001-01-01' WHERE id = ?").run(batch.id);
    expect(await check()).toMatchObject({ status: 'DISCARD', expired: true });
  });

  it('unknown and malformed tokens get the same generic 404', async () => {
    const t = makeApp();
    const unknown = await t.http().get(`/api/public/batch/${newPublicToken()}`);
    const malformed = await t.http().get('/api/public/batch/1');
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
    expect(unknown.headers['cache-control']).toBe('no-store');
  });

  it('is rate limited per IP (60 per minute)', async () => {
    const t = makeApp();
    const token = newPublicToken();
    for (let i = 0; i < 60; i++) expect((await t.http().get(`/api/public/batch/${token}`)).status).toBe(404);
    expect((await t.http().get(`/api/public/batch/${token}`)).status).toBe(429);
  });

  it('tokens are random 72-bit URL-safe strings, not sequential', () => {
    const tokens = Array.from({ length: 2000 }, newPublicToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const tok of tokens) expect(tok).toMatch(/^[A-Za-z0-9_-]{12}$/); // 12 x 6 bits = 72 bits >= 70
    expect(new Set(tokens.join('')).size).toBeGreaterThan(60); // the whole 64-symbol alphabet is in use
  });
});

describe('inventory support', () => {
  it('batch detail carries the public URL its QR encodes; audit entries filter by batch', async () => {
    const t = makeApp({ PUBLIC_BASE_URL: 'https://cc.example' });
    const batch = mk(t, addFridge(t));
    const other = mk(t, addFridge(t));
    const auth = await asRole(t, 'INSPECTOR');
    const detail = await t.http().get(`/api/batches/${batch.id}`).set(auth);
    expect(detail.body.public_url).toBe(`https://cc.example/check/${batch.public_token}`);
    const audit = await t.http().get(`/api/audit?batch_id=${batch.id}`).set(auth);
    expect(
      audit.body.entries.map((e: { event_type: string; payload: { batch_id: number } }) => [
        e.event_type,
        e.payload.batch_id,
      ]),
    ).toEqual([['BATCH_CREATED', batch.id]]);
    expect(other.id).not.toBe(batch.id);
  });
});
