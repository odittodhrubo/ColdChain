import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '../auth/session';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from '../test-utils';
// lazy routes these tests land on: load them up front, so no test pays for transforming the chunk
import '../pages/AccountGatePage';
import '../pages/AccountPage';
import '../pages/DashboardPage';

const USER = { id: 1, email: 'admin@coldchain.local', name: 'Test ADMIN', role: 'ADMIN' as const };
const sessionBody = (over: object = {}) => ({
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: USER,
  mustChangePassword: false,
  totpEnabled: false,
  mfaSetupRequired: false,
  ...over,
});
const me = (over: object = {}) => ({
  'GET /api/auth/me': {
    status: 200,
    body: { user: USER, mustChangePassword: false, totpEnabled: false, mfaSetupRequired: false, ...over },
  },
});

beforeEach(() => {
  sessionStorage.clear();
  session.reset();
});
afterEach(() => vi.unstubAllGlobals());

describe('two-factor sign-in (S3)', () => {
  it('asks for the app code after the password, then signs in', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      ...me(),
      'POST /api/auth/login': { status: 200, body: { mfaRequired: true, mfaToken: 'mfa-1' } },
      'POST /api/auth/totp/verify': (init) => {
        const body = JSON.parse(String(init.body));
        return body.code === '123456'
          ? { status: 200, body: sessionBody({ totpEnabled: true }) }
          : { status: 401, body: { error: { code: 'INVALID_CODE', message: 'no' } } };
      },
    });
    renderApp('/');
    await user.type(await screen.findByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), 'Some-Pass-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Two-factor sign-in' })).toBeInTheDocument();
    expect(session.get()).toBeNull(); // the password alone is not a session

    await user.type(screen.getByLabelText('Code'), '999999');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right');

    await user.type(screen.getByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    const verify = calls.filter((c) => c.url === '/api/auth/totp/verify').at(-1)!;
    expect(JSON.parse(String(verify.init.body))).toEqual({ mfaToken: 'mfa-1', code: '123456' });
  });

  it('accepts a recovery code instead of the app code', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      ...me(),
      'POST /api/auth/login': { status: 200, body: { mfaRequired: true, mfaToken: 'mfa-2' } },
      'POST /api/auth/totp/verify': { status: 200, body: sessionBody() },
    });
    renderApp('/');
    await user.type(await screen.findByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), 'Some-Pass-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), ' abcd-efgh-jkmn ');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    const verify = calls.find((c) => c.url === '/api/auth/totp/verify')!;
    expect(JSON.parse(String(verify.init.body))).toEqual({
      mfaToken: 'mfa-2',
      recoveryCode: 'abcd-efgh-jkmn',
    });
  });

  it('setup shows the QR and the key, and the recovery codes once confirmed', async () => {
    const user = userEvent.setup();
    signIn('ADMIN');
    mockApi({
      ...DEFAULT_ROUTES,
      ...me(),
      'POST /api/auth/totp/setup': {
        status: 200,
        body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x', qrSvg: '<svg/>' },
      },
      'POST /api/auth/totp/confirm': {
        status: 200,
        body: { totpEnabled: true, recoveryCodes: Array.from({ length: 10 }, (_, i) => `code-${i}aaa-bbbb`) },
      },
    });
    renderApp('/account');
    await user.click(await screen.findByRole('button', { name: 'Set up two-factor sign-in' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code from the authenticator app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor sign-in' }));
    expect(await screen.findByText('code-0aaa-bbbb')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('code-'))).toHaveLength(
      10,
    );
    await user.click(screen.getByRole('button', { name: 'I saved them' }));
    expect(await screen.findByText(/On: signing in needs your password/)).toBeInTheDocument();
    expect(screen.queryByText('code-0aaa-bbbb')).toBeNull(); // shown once
  });
});

describe('password change (S2)', () => {
  it('a password set by someone else sends the user to the gate first, then back to the app', async () => {
    const user = userEvent.setup();
    signIn('ADMIN');
    session.set({ ...session.get()!, mustChangePassword: true });
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      ...me({ mustChangePassword: true }),
      'POST /api/auth/password': { status: 200, body: sessionBody() },
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Choose your own password' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'Temp-Pass-1234');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('At least 10 characters')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/auth/password')).toBe(false); // checked before sending

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'My-Own-Pass-77');
    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.type(screen.getByLabelText('Repeat the new password'), 'My-Own-Pass-77');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument(),
    );
    expect(session.get()!.mustChangePassword).toBe(false);
  });

  it('a wrong current password is named on its field', async () => {
    const user = userEvent.setup();
    signIn('PHARMACIST');
    mockApi({
      ...DEFAULT_ROUTES,
      ...me(),
      'POST /api/auth/password': {
        status: 400,
        body: { error: { code: 'INVALID_CURRENT_PASSWORD', message: 'The current password is not right' } },
      },
    });
    renderApp('/account');
    await user.type(await screen.findByLabelText('Current password'), 'Wrong-Pass-123');
    await user.type(screen.getByLabelText('New password'), 'My-Own-Pass-77');
    await user.type(screen.getByLabelText('Repeat the new password'), 'My-Own-Pass-77');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('This is not your current password')).toBeInTheDocument();
    expect(session.get()).not.toBeNull(); // a refused change does not sign anyone out
  });
});
