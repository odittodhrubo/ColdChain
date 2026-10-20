import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../auth/session';
import type { Role } from '../auth/permissions';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from '../test-utils';
import './SecurityPage'; // the route is lazy: load it up front

const summary = (over: object = {}) => ({
  window_s: 3600,
  accepted: 120,
  rejected: 0,
  by_reason: [],
  server_time: Date.now(),
  devices: [
    {
      device_id: 'fridge-01',
      fridge_id: 'fridge-01',
      active: true,
      last_seen_at: Date.now() - 4000,
      open_gap: null,
      clock_skew_s: 0,
      rotation_pending: false,
      secret_rotated_at: null,
      ...over,
    },
  ],
});
const routes = (role: Role, over: object = {}) => ({
  ...DEFAULT_ROUTES,
  'GET /api/auth/me': {
    status: 200,
    body: {
      user: { id: 1, email: 'x@coldchain.local', name: `Test ${role}`, role },
      mustChangePassword: false,
    },
  },
  'GET /api/security/summary': { status: 200, body: summary(over) },
  'GET /api/security/events': { status: 200, body: { events: [], total: 0, page: 1, pageSize: 50 } },
});

beforeEach(() => {
  sessionStorage.clear();
  session.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe('device secret rotation (S7)', () => {
  it('an Admin rotates a secret with a reason; the request carries no secret', async () => {
    const user = userEvent.setup();
    signIn('ADMIN');
    const { calls } = mockApi({
      ...routes('ADMIN'),
      'POST /api/devices/fridge-01/rotate-secret': {
        status: 202,
        body: { device_id: 'fridge-01', cmd_id: 'c1', status: 'PENDING' },
      },
    });
    renderApp('/security');
    await user.click(await screen.findByRole('button', { name: 'Rotate the secret of fridge-01' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await within(dialog).findByText(/Say why/)).toBeInTheDocument(); // a reason is required
    await user.type(within(dialog).getByLabelText('Reason'), 'laptop with config.h lost');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await screen.findByText('New secret sent to fridge-01')).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/api/devices/fridge-01/rotate-secret')!;
    expect(JSON.parse(String(post.init.body))).toEqual({ reason: 'laptop with config.h lost' });
  });

  it('shows a pending rotation instead of the button, and Inspectors never see the action', async () => {
    signIn('ADMIN');
    mockApi(routes('ADMIN', { rotation_pending: true }));
    const first = renderApp('/security');
    expect(await screen.findByText('secret rotation pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rotate the secret/ })).toBeNull();
    first.unmount();

    sessionStorage.clear();
    session.reset();
    signIn('INSPECTOR');
    mockApi(routes('INSPECTOR'));
    renderApp('/security');
    expect(await screen.findByText(/last accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rotate the secret/ })).toBeNull();
  });
});
