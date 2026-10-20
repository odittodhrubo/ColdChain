import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from './auth/session';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from './test-utils';
// the routes these tests land on are lazy: load them up front, so no test pays for transforming the chunk
// (seconds when every suite runs at once, which timed the login test out)
import './pages/AlertsPage';
import './pages/DashboardPage';
import { StatusChip } from './ui/StatusChip';
import { STATUS, type Status } from './ui/status';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  session.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const me = (role: string) => ({
  'GET /api/auth/me': { status: 200, body: { user: { id: 1, email: 'x', name: `Test ${role}`, role } } },
});

describe('auth guard', () => {
  it('sends a signed-out visitor to the login page', async () => {
    mockApi(DEFAULT_ROUTES);
    renderApp('/inventory');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows a no-permission page for a route the role cannot open', async () => {
    mockApi({ ...DEFAULT_ROUTES, ...me('INSPECTOR') });
    signIn('INSPECTOR');
    renderApp('/users');
    expect(
      await screen.findByRole('heading', { name: "This page isn't available to your role" }),
    ).toBeInTheDocument();
  });

  it('logs out when the server answers 401 (expired or revoked token)', async () => {
    mockApi({
      ...DEFAULT_ROUTES,
      ...me('PHARMACIST'),
      'GET /api/alerts': {
        status: 401,
        body: { error: { code: 'TOKEN_EXPIRED', message: 'Token expired' } },
      },
    });
    signIn('PHARMACIST');
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
  });

  it('a stored session that has already expired is not used', async () => {
    mockApi(DEFAULT_ROUTES);
    signIn('ADMIN', -10);
    session.reset();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('role-based navigation', () => {
  const links = async () =>
    within((await screen.findAllByRole('navigation', { name: 'Main' }))[0])
      .getAllByRole('link')
      .map((a) => a.textContent);

  it('Admin sees every section, including Users', async () => {
    mockApi({ ...DEFAULT_ROUTES, ...me('ADMIN') });
    signIn('ADMIN');
    renderApp('/');
    expect(await links()).toEqual([
      'Dashboard', 'Fridges', 'Inventory', 'Alerts', 'Relocations', 'AI Report', 'Security', 'Audit Log', 'Users',
    ]); // prettier-ignore
  });

  it.each(['PHARMACIST', 'INSPECTOR'] as const)('%s does not see Users', async (role) => {
    mockApi({ ...DEFAULT_ROUTES, ...me(role) });
    signIn(role);
    renderApp('/');
    const items = await links();
    expect(items).not.toContain('Users');
    expect(items).toContain('Audit Log');
  });
});

describe('login', () => {
  it('shows a clear error, toggles password visibility, then signs in', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockApi({
      ...DEFAULT_ROUTES,
      ...me('PHARMACIST'),
      'POST /api/auth/login': () =>
        ++attempts === 1
          ? {
              status: 401,
              body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } },
            }
          : {
              status: 200,
              body: {
                token: 'jwt-1',
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                user: {
                  id: 1,
                  email: 'pharmacist@coldchain.local',
                  name: 'Test PHARMACIST',
                  role: 'PHARMACIST',
                },
              },
            },
    });
    renderApp('/alerts');
    await user.type(await screen.findByLabelText('Email'), 'pharmacist@coldchain.local');
    const password = screen.getByLabelText('Password');
    await user.type(password, 'wrong-password');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is not correct.');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Alerts' })).toBeInTheDocument(); // back where they were going
    // the session cookie is HttpOnly: even a token in the response body never lands in storage
    const stored = sessionStorage.getItem('coldchain.session')!;
    expect(JSON.parse(stored).user.role).toBe('PHARMACIST');
    expect(stored).not.toContain('jwt-1');
    expect(Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('jwt-1'))).toBe(
      false,
    );
  });

  it('sign out revokes the token on the server and clears the session', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      ...me('ADMIN'),
      'POST /api/auth/logout': { status: 204 },
    });
    signIn('ADMIN');
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Test ADMIN/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem('coldchain.session')).toBeNull();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/auth/logout')).toBe(true),
    );
  });
});

describe('shell', () => {
  it('global status pill: all safe, then open alerts with the critical count', async () => {
    mockApi({
      ...DEFAULT_ROUTES,
      ...me('ADMIN'),
      'GET /api/alerts?status=active&severity=CRITICAL': { status: 200, body: { alerts: [], total: 1 } },
      'GET /api/alerts?status=active&pageSize': { status: 200, body: { alerts: [], total: 3 } },
    });
    signIn('ADMIN');
    renderApp('/');
    expect(await screen.findByRole('link', { name: /3 open alerts, 1 critical/ })).toHaveAttribute(
      'href',
      '/alerts',
    );
  });

  it('shows the DEMO banner when exposure is accelerated', async () => {
    mockApi({
      ...DEFAULT_ROUTES,
      ...me('ADMIN'),
      'GET /api/health': { status: 200, body: { demoScale: 30 } },
    });
    signIn('ADMIN');
    renderApp('/');
    expect(await screen.findByRole('note')).toHaveTextContent('DEMO MODE — heat exposure accelerated ×30');
  });

  it('connection indicator: live over the socket, polling every 5 s when it is blocked', async () => {
    const { fetchMock } = mockApi({ ...DEFAULT_ROUTES, ...me('ADMIN') });
    signIn('ADMIN');
    const { socket } = renderApp('/');
    expect(await screen.findByText('Connecting')).toBeInTheDocument();
    act(() => socket.emit('connect'));
    expect(await screen.findByText('Live')).toBeInTheDocument();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => socket.emit('connect_error', new Error('blocked')));
    expect(await screen.findByText('Polling every 5 s')).toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before)); // refetched without the socket
  });

  it('opens one socket per session (cookie auth, no token handed over) and closes it on sign out', async () => {
    mockApi({ ...DEFAULT_ROUTES, ...me('ADMIN'), 'POST /api/auth/logout': { status: 204 } });
    signIn('ADMIN');
    const keys: string[] = [];
    const { FakeSocket } = await import('./test-utils');
    const sock = new FakeSocket();
    const { Providers, AppRoutes } = await import('./App');
    const { MemoryRouter } = await import('react-router');
    render(
      <MemoryRouter>
        <Providers connect={(k) => (keys.push(k), sock)}>
          <AppRoutes />
        </Providers>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /Test ADMIN/ });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^1:\d+$/); // user id and session expiry: a new session opens a new socket
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Test ADMIN/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(sock.disconnected).toBe(true));
    // logout goes to the server with the cookie; the page never had a token to send
    const logout = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(
      ([u]) => u === '/api/auth/logout',
    );
    expect(logout?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.stringify(logout?.[1].headers ?? {})).not.toMatch(/Authorization/);
  });
});

describe('status vocabulary', () => {
  it('every status carries a word and a glyph, not colour alone', () => {
    for (const s of Object.keys(STATUS) as Status[]) {
      const { container, unmount } = render(<StatusChip status={s} />);
      expect(container.textContent).toBe(STATUS[s].label);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });
});

describe('VVM mark', () => {
  it('pulses when its status changes, never on first render', async () => {
    const { VvmMark } = await import('./ui/VvmMark');
    const { container, rerender } = render(<VvmMark status="SAFE" />);
    expect(container.querySelector('svg')).not.toHaveClass('vvm-pulse');
    rerender(<VvmMark status="WARNING" />);
    expect(container.querySelector('svg')).toHaveClass('vvm-pulse');
  });
});
