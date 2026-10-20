import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '../auth/permissions';
import type { Batch, Fridge } from '../lib/types';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from '../test-utils';
import { verifyStream } from './AuditPage';
import { burstIds } from './SecurityPage';
import { passwordProblem } from './UsersPage';
import './InventoryPage'; // the route is lazy: load it up front so the first test does not pay for it

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
    'DELETE /api/batches/': { status: 200, body: { deleted: true } },
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
    expect(within(row).queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /^Remove/ })).toBeInTheDocument(); // admin can remove any row
    // acknowledged right here: the fridge's reset dialog opens in place
    await userEvent.click(within(row).getByRole('button', { name: 'Acknowledge disposal' }));
    expect(screen.getByRole('dialog', { name: /Reset the discard latch on/ })).toBeInTheDocument();
  });

  it('a pharmacist sees "Disposal required" but cannot acknowledge or remove', async () => {
    inventory('PHARMACIST', [batch({ status: 'DISCARD', remaining_pct: 0, discarded_at: 1 })]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(within(row).getByText('Disposal required')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Acknowledge|^Remove/ })).toBeNull();
  });

  it('an Admin removes a disposed batch from the inventory', async () => {
    const disposed = batch({ status: 'DISCARD', remaining_pct: 0, discarded_at: 1, acknowledged_at: 2 });
    inventory('ADMIN', [disposed]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(within(row).getByText('Disposal acknowledged')).toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Remove Measles-Rubella from the inventory' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove Measles-Rubella (MR-1) from the inventory?' });
    expect(dialog).toHaveTextContent('QR code keeps showing Discard');
    const confirm = within(dialog).getByRole('button', { name: 'Remove batch' });
    expect(confirm).toBeDisabled(); // a reason is required
    await userEvent.type(
      within(dialog).getByLabelText('Reason (recorded in the audit log)'),
      'disposed per SOP',
    );
    await userEvent.click(confirm);
    expect(await screen.findByText('Measles-Rubella removed from the inventory')).toBeInTheDocument();
    const del = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(del?.[0]).toBe('/api/batches/7');
    expect(JSON.parse((del![1].body as string) ?? '{}')).toEqual({ reason: 'disposed per SOP' });
  });

  it('a pharmacist cannot delete a live batch', async () => {
    inventory('PHARMACIST', [batch()]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('an Admin can delete any batch with a reason', async () => {
    inventory('ADMIN', [batch()]);
    const row = (await screen.findByText('Measles-Rubella')).closest('tr')!;
    await userEvent.click(
      within(row).getByRole('button', { name: 'Remove Measles-Rubella from the inventory' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText('Reason (recorded in the audit log)'),
      'duplicate entry',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove batch' }));
    expect(await screen.findByText('Measles-Rubella removed from the inventory')).toBeInTheDocument();
  });

  it('batch text is rendered as text, never as markup (stored XSS)', async () => {
    const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    inventory('INSPECTOR', [batch({ name: xss, manufacturer: xss })]);
    const row = (await screen.findAllByText(xss))[0].closest('tr')!;
    expect(row.querySelector('img, script')).toBeNull();
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

describe('inventory: pagination', () => {
  // 40 batches named B01..B40, so the default sort (budget left, all equal) keeps the server order
  const many = Array.from({ length: 40 }, (_, i) =>
    batch({ id: i + 1, name: `B${String(i + 1).padStart(2, '0')}`, lot_number: `L-${i + 1}` }),
  );
  const bodyRows = (root: HTMLElement) => within(root).getAllByRole('row').slice(1);

  it('shows 15 batches per page, steps through, and a new filter returns to page 1', async () => {
    inventory('INSPECTOR', many);
    await screen.findByText('B01');
    const table = screen.getByRole('table', { name: 'Vaccine batches' });
    expect(bodyRows(table)).toHaveLength(15);
    expect(screen.getByText('1–15 of 40')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('31–40 of 40')).toBeInTheDocument();
    expect(bodyRows(screen.getByRole('table', { name: 'Vaccine batches' }))).toHaveLength(10);
    await userEvent.click(screen.getByLabelText(/expiring/i));
    expect(await screen.findByText('1–15 of 40')).toBeInTheDocument();
  });

  it('View all lists every batch in a dialog, with the row actions still there', async () => {
    inventory('PHARMACIST', many);
    await screen.findByText('B01');
    await userEvent.click(screen.getByRole('button', { name: 'View all (40)' }));
    const dialog = screen.getByRole('dialog', { name: 'Inventory: all 40' });
    expect(bodyRows(within(dialog).getByRole('table'))).toHaveLength(40);
    expect(within(dialog).getByRole('button', { name: 'Edit B40' })).toBeInTheDocument();
  });
});

describe('alerts: Previous / Next paging', () => {
  const alert = (id: number) => ({
    id,
    type: 'FRIDGE_OFFLINE',
    severity: 'WARNING',
    fridge_id: 'fridge-01',
    batch_id: null,
    data: { title: `Alert ${id}` },
    delivery_status: {},
    created_at: 1_700_000_000_000 + id,
    status: 'RESOLVED',
  });

  it('asks the server for the next page and back, within the 15-per-page window', async () => {
    signIn('INSPECTOR');
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      'GET /api/auth/me': {
        status: 200,
        body: { user: { id: 1, email: 'x', name: 'T', role: 'INSPECTOR' } },
      },
      'GET /api/fridges': { status: 200, body: { fridges: [fridge], server_time: Date.now(), demoScale: 1 } },
      'GET /api/alerts': ({ url }) => {
        const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
        const all = Array.from({ length: 16 }, (_, i) => alert(i + 1));
        return { status: 200, body: { alerts: all.slice((page - 1) * 15, page * 15), total: 16 } };
      },
    });
    renderApp('/alerts');
    expect(await screen.findByText('Alert 1')).toBeInTheDocument();
    expect(screen.getByText('1–15 of 16')).toBeInTheDocument();
    const prev = screen.getByRole('button', { name: 'Previous' });
    expect(prev).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Alert 16')).toBeInTheDocument();
    expect(screen.getByText('16–16 of 16')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('page=2'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Alert 1')).toBeInTheDocument();
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

describe('audit log: 20 per page, Previous / Next', () => {
  const entry = (id: number) => ({
    id,
    ts: 1_700_000_000_000 + id,
    actor: 'system',
    event_type: 'DEVICE_EVENT',
    payload: { seq: id },
    prev_hash: `p${id}`,
    hash: `h${id}`,
  });

  it('asks the server for 20 at a time and steps forward and back', async () => {
    signIn('INSPECTOR');
    const all = Array.from({ length: 25 }, (_, i) => entry(25 - i)); // newest first
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      'GET /api/auth/me': {
        status: 200,
        body: { user: { id: 1, email: 'x', name: 'T', role: 'INSPECTOR' } },
      },
      'GET /api/audit': ({ url }) => {
        const u = new URL(url, 'http://x');
        expect(u.searchParams.get('pageSize')).toBe('20');
        const page = Number(u.searchParams.get('page') ?? '1');
        return { status: 200, body: { entries: all.slice((page - 1) * 20, page * 20), total: 25 } };
      },
    });
    renderApp('/audit');
    expect(await screen.findByText('1–20 of 25')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('DEVICE_EVENT');
    const prev = screen.getByRole('button', { name: 'Previous' });
    expect(prev).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('21–25 of 25')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('page=2'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('1–20 of 25')).toBeInTheDocument();
  });
});

describe('audit log: row details', () => {
  const entry = (o = {}) => ({
    id: 42,
    ts: 1_700_000_000_000,
    actor: 'user:1',
    event_type: 'DISCARD_ACK',
    payload: { fridge_id: 'fridge-02', batch_ids: [10], reason: 'vials destroyed' },
    prev_hash: 'a'.repeat(64),
    hash: 'b'.repeat(64),
    ...o,
  });

  it('opens a record and shows its full payload and hashes', async () => {
    signIn('INSPECTOR');
    mockApi({
      ...DEFAULT_ROUTES,
      'GET /api/auth/me': {
        status: 200,
        body: { user: { id: 1, email: 'x', name: 'T', role: 'INSPECTOR' } },
      },
      'GET /api/audit': { status: 200, body: { entries: [entry()], total: 1 } },
    });
    renderApp('/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
    const dialog = screen.getByRole('dialog', { name: 'Audit record #42' });
    expect(within(dialog).getByText('DISCARD_ACK')).toBeInTheDocument();
    expect(within(dialog).getByText(/vials destroyed/)).toBeInTheDocument();
    expect(within(dialog).getByText('b'.repeat(64))).toBeInTheDocument();
  });

  it('shows a tampered (non-JSON) payload as raw text with a warning', async () => {
    signIn('INSPECTOR');
    mockApi({
      ...DEFAULT_ROUTES,
      'GET /api/auth/me': {
        status: 200,
        body: { user: { id: 1, email: 'x', name: 'T', role: 'INSPECTOR' } },
      },
      'GET /api/audit': {
        status: 200,
        body: { entries: [entry({ payload: '{"x":1} [tampered]', payload_invalid: true })], total: 1 },
      },
    });
    renderApp('/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/not valid JSON/)).toBeInTheDocument();
    expect(within(dialog).getByText('{"x":1} [tampered]')).toBeInTheDocument();
  });
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
