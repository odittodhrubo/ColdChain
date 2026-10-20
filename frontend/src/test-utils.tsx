import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppRoutes, Providers } from './App';
import type { Role } from './auth/permissions';
import { session } from './auth/session';
import type { SocketLike } from './realtime/RealtimeProvider';

/** A Socket.IO stand-in the test drives by hand. */
export class FakeSocket implements SocketLike {
  handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  disconnected = false;
  on(event: string, fn: (...a: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  disconnect() {
    this.disconnected = true;
  }
}

export function signIn(role: Role, expiresInS = 3600) {
  session.set({
    expiresAt: Math.floor(Date.now() / 1000) + expiresInS,
    user: { id: 1, email: `${role.toLowerCase()}@coldchain.local`, name: `Test ${role}`, role },
  });
}

type Handler = (init: RequestInit & { url: string }) => { status: number; body?: unknown };

/** fetch stub routed by "METHOD /path" prefix; unknown routes answer 404. */
export function mockApi(routes: Record<string, Handler | { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const key = Object.keys(routes)
      .filter((k) => `${method} ${url}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const r = key
      ? routes[key]
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } };
    const { status, body } = typeof r === 'function' ? r({ ...init, url }) : r;
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export const DEFAULT_ROUTES = {
  'GET /api/health': { status: 200, body: { status: 'ok', demoScale: 1 } },
  'GET /api/alerts': { status: 200, body: { alerts: [], total: 0, page: 1, pageSize: 1 } },
  'GET /api/auth/me': { status: 200, body: { user: { id: 1, email: 'x', name: 'Test', role: 'ADMIN' } } },
};

export function renderApp(path = '/', socket = new FakeSocket()) {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <Providers connect={() => socket}>
        <AppRoutes />
      </Providers>
    </MemoryRouter>,
  );
  return { ...utils, socket };
}
