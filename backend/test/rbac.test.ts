import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, ROLES, type Role } from '../src/rbac/permissions';
import type { RouteDef } from '../src/shared/http';
import { addUser, bearer, makeApp, PASSWORD, tokenFor, type TestApp } from './helpers';

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
    expect(roles('relocation:confirm')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('alert:ack')).toEqual(['ADMIN', 'PHARMACIST']);
    expect(roles('latch:reset')).toEqual(['ADMIN']);
    expect(roles('user:manage')).toEqual(['ADMIN']);
    expect(roles('audit:read')).toEqual(['ADMIN', 'INSPECTOR', 'PHARMACIST']);
    expect(roles('audit:verify')).toEqual(['ADMIN', 'INSPECTOR', 'PHARMACIST']);
  });
});
