import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '../auth/permissions';
import type { Batch, Fridge } from '../lib/types';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from '../test-utils';
import { verifyStream } from './AuditPage';
import { burstIds } from './SecurityPage';
import { passwordProblem } from './UsersPage';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
});

const PUBLIC = {
  name: 'Pentavalent',
  lot_number: 'PV-2291',
  expiry_date: '2027-03-31',
  status: 'SAFE',
  expired: false,
  last_checked: '2026-10-18T07:00:00.000Z',
};

describe('public check page (/check/:token)', () => {
  it.each([
    ['SAFE', 'SAFE', /safe to use/i],
    ['AT_RISK', 'AT RISK', /pharmacist’s instruction/i],
    ['DISCARD', 'DISCARD', /do not use/i],
  ])('%s: verdict word and plain guidance, no login, no app chrome', async (status, word, guidance) => {
    const { calls } = mockApi({
      'GET /api/public/batch/tok123': { status: 200, body: { ...PUBLIC, status } },
    });
    renderApp('/check/tok123');
    expect(await screen.findByRole('heading', { level: 1, name: word })).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
    expect(screen.getByText('PV-2291')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull(); // no sidebar or top bar
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
  });

  it('flags an expired batch', async () => {
    mockApi({ 'GET /api/public/batch/old': { status: 200, body: { ...PUBLIC, expired: true } } });
    renderApp('/check/old');
    expect(await screen.findByText('Expired')).toBeInTheDocument();
  });

  it('unknown token: "Batch not found"; rate limited: asks to wait', async () => {
    mockApi({
      'GET /api/public/batch/nope': {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Not found' } },
      },
      'GET /api/public/batch/busy': {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Slow down' } },
      },
    });
    const first = renderApp('/check/nope');
    expect(await screen.findByRole('heading', { name: 'Batch not found' })).toBeInTheDocument();
    first.unmount();
    renderApp('/check/busy');
    expect(await screen.findByText(/wait a minute/i)).toBeInTheDocument();
  });
});

const fridge: Partial<Fridge> = {
  id: 'fridge-01',
  name: 'Fridge 1',
  capacity: 20,
  load: 1,
  status: 'SAFE',
  live: null,
};
const batch = (o: Partial<Batch> = {}): Batch => ({
  id: 7,
  public_token: 'tok',
  name: 'Measles-Rubella',
  manufacturer: 'SII',
  lot_number: 'MR-1',
  quantity: 40,
  expiry_date: '2030-01-01',
  criticality: 2,
  fridge_id: 'fridge-01',
  status: 'SAFE',
  expired: false,
  weighted_exposure_s: 0,
  remaining_pct: 100,
  used_minutes: 0,
  discarded_at: null,
  acknowledged_at: null,
  ...o,
});

function inventory(role: Role, batches: Batch[]) {
  signIn(role);
  mockApi({
    ...DEFAULT_ROUTES,
    'GET /api/auth/me': { status: 200, body: { user: { id: 1, email: 'x', name: 'Test', role } } },
    'GET /api/fridges': { status: 200, body: { fridges: [fridge], server_time: Date.now(), demoScale: 1 } },
    'GET /api/batches': { status: 200, body: { batches, total: batches.length, demoScale: 1 } },
  });
  renderApp('/inventory');
}

describe('inventory: what each role can do', () => {
  it('a pharmacist can add, edit and move; everyone can open the QR and details', async () => {
    inventory('PHARMACIST', [batch()]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(screen.getByRole('button', { name: 'Add batch' })).toBeInTheDocument();
    for (const name of [
      'Edit Measles-Rubella',
      'Move Measles-Rubella',
      'QR label for Measles-Rubella',
      'Details of Measles-Rubella',
    ])
      expect(within(row).getByRole('button', { name })).toBeInTheDocument();
  });

  it('an inspector sees the inventory read-only', async () => {
    inventory('INSPECTOR', [batch()]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(screen.queryByRole('button', { name: 'Add batch' })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Edit|^Move/ })).toBeNull();
    expect(within(row).getByRole('button', { name: 'QR label for Measles-Rubella' })).toBeInTheDocument();
  });

  it('a discarded batch is struck through, cannot be moved, and asks for disposal', async () => {
    inventory('ADMIN', [batch({ status: 'DISCARD', remaining_pct: 0, discarded_at: 1 })]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(within(row).getByText('Disposal required')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Acknowledge disposal' })).toHaveAttribute(
      'href',
      '/fridges/fridge-01',
    );
    expect(within(row).queryByRole('button', { name: /^Move/ })).toBeNull();
  });

  it('the add form validates before sending', async () => {
    inventory('PHARMACIST', []);
    await userEvent.click(await screen.findByRole('button', { name: 'Add batch' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add batch' }));
    expect(within(dialog).getByText('Enter the product name')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a fridge')).toBeInTheDocument();
  });
});

describe('security: burst highlighting', () => {
  const ev = (id: number, ts: number, device_id = 'fridge-01', reason = 'BAD_SIG') => ({
    id,
    ts,
    device_id,
    reason,
    topic: null,
    size: null,
    sample_hash: null,
    detail: null,
  });
  it('5+ rejects with the same device and reason inside a minute form a burst', () => {
    const burst = [0, 10, 20, 30, 60].map((t, i) => ev(i + 1, 1000 + t));
    const spread = [0, 70, 140, 210, 280].map((t, i) => ev(i + 10, 1000 + t, 'fridge-03'));
    const mixed = [0, 1, 2, 3]
      .map((t, i) => ev(i + 20, 1000 + t, 'fridge-02'))
      .concat(ev(30, 1004, 'fridge-02', 'REPLAY'));
    expect([...burstIds([...burst, ...spread, ...mixed])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('users: password rule matches the server', () => {
  it.each([
    ['short1A!', 'At least 10 characters'],
    ['alllowercase1', 'Mix at least three of: lowercase, uppercase, digits, symbols'],
    ['Lowercase12', null],
    ['lower-case-12', null],
  ])('%s', (pw, problem) => expect(passwordProblem(pw)).toBe(problem));
});

describe('audit: Verify Integrity stream', () => {
  it('reads progress lines split across chunks, then the result', async () => {
    const lines =
      '{"progress":{"checked":500,"total":1200}}\n{"progress":{"checked":1200,"total":1200}}\n{"result":{"valid":false,"checked":41,"headId":1200,"headHash":"ab","firstBrokenId":42,"reason":"HASH_MISMATCH"}}\n';
    const chunks = [lines.slice(0, 17), lines.slice(17, 60), lines.slice(60)];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start: (c) => (chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))), c.close()),
            }),
          ),
      ),
    );
    const progress: number[] = [];
    const result = await verifyStream((checked) => progress.push(checked));
    expect(progress).toEqual([500, 1200]);
    expect(result).toMatchObject({ valid: false, firstBrokenId: 42, reason: 'HASH_MISMATCH' });
  });

  it('a refused request surfaces as an error', async () => {
    mockApi({
      'GET /api/audit/verify': { status: 403, body: { error: { code: 'FORBIDDEN', message: 'No' } } },
    });
    await expect(verifyStream(() => {})).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
