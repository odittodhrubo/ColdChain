import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { can, PERMISSIONS, ROLES, type Role } from '../src/rbac/permissions';
import type { RouteDef } from '../src/shared/http';
import { type BatchInput, createBatch } from '../src/modules/batches/service';
import type { AppContext } from '../src/shared/http';
import { encryptSecret } from '../src/shared/secretbox';
import { addFridge, addUser, batchInput, bearer, makeApp, PASSWORD, tokenFor, type TestApp } from './helpers';
import { proposedPlan } from './relocationHelpers';

const ctxOf = (t: TestApp) => t.app.locals.ctx as AppContext;
/** A fridge with an active device (secret encrypted like the seed does). */
function fridgeWithDevice(t: TestApp) {
  const f = addFridge(t);
  t.db
    .prepare('INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES (?, ?, ?, 0)')
    .run(`dev-${f}`, f, encryptSecret('ab'.repeat(32), t.config.APP_SECRET_KEY));
  return f;
}
const newAlert = (t: TestApp) =>
  ctxOf(t).alerts.raise({
    type: 'FRIDGE_OFFLINE',
    severity: 'WARNING',
    fridgeId: addFridge(t),
    title: 'x',
    lines: [],
  });

const newBatch = (t: TestApp, over: Record<string, unknown> = {}) =>
  createBatch(t.app.locals.ctx as AppContext, batchInput(addFridge(t), over) as BatchInput);

// One valid request per route. A route registered without an entry here fails the suite: every new route
// must come with a permission decision and a test (deny by default).
type Example = (t: TestApp) => Promise<{ path?: string; body?: object }>;
const EXAMPLES: Record<string, Example> = {
  'GET /api/health': async () => ({}),
  'POST /api/auth/login': async (t) => ({
    body: { email: (await addUser(t, 'INSPECTOR')).email, password: PASSWORD },
  }),
  'GET /api/auth/me': async () => ({}),
  'POST /api/auth/logout': async () => ({}),
  'GET /api/users': async () => ({}),
  'POST /api/users': async () => ({
    body: {
      email: `new${Math.random().toString(36).slice(2)}@test.local`,
      name: 'New',
      role: 'INSPECTOR',
      password: 'Another-Pass-7',
    },
  }),
  'PATCH /api/users/:id': async (t) => ({
    path: `/api/users/${(await addUser(t, 'INSPECTOR')).id}`,
    body: { name: 'Renamed' },
  }),
  'DELETE /api/users/:id': async (t) => ({ path: `/api/users/${(await addUser(t, 'INSPECTOR')).id}` }),
  'GET /api/audit': async () => ({ path: '/api/audit?page=1&pageSize=5' }),
  'GET /api/audit/verify': async () => ({}),
  'GET /api/security/events': async () => ({ path: '/api/security/events?reason=BAD_SIG' }),
  'GET /api/metrics/ingest': async () => ({}),
  'GET /api/security/summary': async () => ({}),
  'GET /api/relocations': async () => ({}),
  'GET /api/relocations/:id': async (t) => ({ path: `/api/relocations/${proposedPlan(t).plan.id}` }),
  'POST /api/relocations/:id/confirm': async (t) => {
    const { plan } = proposedPlan(t);
    return { path: `/api/relocations/${plan.id}/confirm`, body: { version: plan.version } };
  },
  'POST /api/relocations/:id/dismiss': async (t) => ({
    path: `/api/relocations/${proposedPlan(t).plan.id}/dismiss`,
    body: { reason: 'Handled by phone' },
  }),
  'GET /api/ml/predictions/:fridgeId': async (t) => ({ path: `/api/ml/predictions/${addFridge(t)}` }),
  'GET /api/ml/report': async () => ({}),
  'GET /api/ml/report/figures/:name': async () => ({ path: '/api/ml/report/figures/actual_vs_pred.png' }),
  'GET /api/batches': async () => ({}),
  'POST /api/batches': async (t) => ({ body: batchInput(addFridge(t)) }),
  'GET /api/batches/:id': async (t) => ({ path: `/api/batches/${newBatch(t).id}` }),
  'PATCH /api/batches/:id': async (t) => ({ path: `/api/batches/${newBatch(t).id}`, body: { quantity: 3 } }),
  'DELETE /api/batches/:id': async (t) => ({ path: `/api/batches/${newBatch(t, { quantity: 0 }).id}` }),
  'POST /api/batches/:id/move': async (t) => ({
    path: `/api/batches/${newBatch(t).id}/move`,
    body: { to_fridge_id: addFridge(t) },
  }),
  'GET /api/batches/:id/qr': async (t) => ({ path: `/api/batches/${newBatch(t).id}/qr` }),
  'GET /api/public/batch/:token': async (t) => ({ path: `/api/public/batch/${newBatch(t).public_token}` }),
  'GET /api/batches/:id/exposure': async (t) => ({ path: `/api/batches/${newBatch(t).id}/exposure` }),
  // an unlatched fridge: the reset is a no-op that answers at once (the device round trip is in exposure.test.ts)
  'POST /api/fridges/:id/reset-latch': async (t) => ({
    path: `/api/fridges/${addFridge(t)}/reset-latch`,
    body: { reason: 'disposed of the discarded vials' },
  }),
  'GET /api/alerts': async () => ({ path: '/api/alerts?status=active&severity=WARNING' }),
  'POST /api/alerts/:id/ack': async (t) => ({ path: `/api/alerts/${newAlert(t).id}/ack` }),
  'POST /api/fridges/:id/buzzer-test': async (t) => ({
    path: `/api/fridges/${fridgeWithDevice(t)}/buzzer-test`,
  }),
  'GET /api/fridges': async () => ({}),
  'GET /api/fridges/:id': async (t) => ({ path: `/api/fridges/${addFridge(t)}` }),
  'GET /api/fridges/:id/readings': async (t) => ({ path: `/api/fridges/${addFridge(t)}/readings?bucket=60` }),
  'GET /api/commands/:id': async (t) => ({
    path: `/api/commands/${ctxOf(t).commands.send(`dev-${fridgeWithDevice(t)}`, 'BUZZER_TEST')}`,
  }),
};

const key = (r: RouteDef) => `${r.method.toUpperCase()} ${r.path}`;

function expected(route: RouteDef, role: Role | null): 'ok' | 401 | 403 {
  if (route.access === 'public') return 'ok';
  if (role === null) return 401;
  if (route.access === 'authenticated') return 'ok';
  return can(role, route.access.permission) ? 'ok' : 403;
}

describe('RBAC: every registered route x every role', async () => {
  const t = makeApp();
  // the ML service is another process: answer its report endpoints here (supertest itself does not use fetch)
  beforeAll(() => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith(t.config.ML_URL)) return real(url, init);
      if (u.includes('/report/figures/')) return new Response(new Uint8Array([137, 80, 78, 71]));
      return Response.json({
        metrics: {},
        report_md: '# r',
        figures: ['actual_vs_pred.png'],
        model_card: null,
      });
    });
  });
  afterAll(() => vi.unstubAllGlobals());
  const routes = t.app.locals.routes as RouteDef[];

  it('every route has an example request and a known access rule', () => {
    expect(routes.map(key).sort()).toEqual(Object.keys(EXAMPLES).sort());
    for (const r of routes) {
      if (typeof r.access === 'object') expect(Object.keys(PERMISSIONS)).toContain(r.access.permission);
      else expect(['public', 'authenticated']).toContain(r.access);
    }
  });

  for (const route of routes) {
    for (const role of [...ROLES, null] as const) {
      const want = expected(route, role);
      it(`${key(route)} as ${role ?? 'anonymous'} -> ${want === 'ok' ? '2xx' : want}`, async () => {
        const { path = route.path, body } = await EXAMPLES[key(route)](t);
        let req = t.http()[route.method](path);
        if (role) req = req.set(bearer(tokenFor(t, await addUser(t, role)))); // fresh user + token: logout cannot leak
        const res = await (body ? req.send(body) : req);
        if (want === 'ok') expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
        if (want === 'ok') expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        else expect(res.status, JSON.stringify(res.body)).toBe(want);
      });
    }
  }
});

describe('permission matrix matches Part 3.8', () => {
  it('maps every capability to exactly the documented roles', () => {
    const roles = (p: keyof typeof PERMISSIONS) => [...PERMISSIONS[p]].sort();
    expect(roles('dashboard:read')).toEqual(['ADMIN', 'INSPECTOR', 'PHARMACIST']);
    expect(roles('batch:write')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('batch:delete')).toEqual(['ADMIN']);
    expect(roles('relocation:confirm')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('alert:ack')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('device:test')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('latch:reset')).toEqual(['ADMIN']);
    expect(roles('user:manage')).toEqual(['ADMIN']);
    expect(roles('audit:read')).toEqual(['ADMIN', 'INSPECTOR', 'PHARMACIST']);
    expect(roles('audit:verify')).toEqual(['ADMIN', 'INSPECTOR', 'PHARMACIST']);
    expect(roles('metrics:read')).toEqual(['ADMIN', 'INSPECTOR']);
  });
});
