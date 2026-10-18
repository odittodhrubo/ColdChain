import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../contracts/test_vectors.json';
import type { Fridge, LiveState } from '../lib/types';
import { STATUS } from '../ui/status';
import { StatusChip } from '../ui/StatusChip';
import { BudgetBar } from './BudgetPanel';
import { accrual, budgetTone, compressorState, doorState, fridgeStatus, staleFor } from './logic';

const NOW = 1_800_000_000_000;
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
const NOW_S = NOW / 1000;

const live = (o: Partial<LiveState> = {}): LiveState => ({
  fridge_id: 'fridge-01',
  device_id: 'fridge-01',
  seq: 1,
  ts: NOW_S,
  temp: 5,
  door: 0,
  comp: 0,
  power: 'MAINS',
  batt: 100,
  state: 'SAFE',
  exp_s: 0,
  latch: 0,
  mode: 'model',
  buf: 0,
  online: true,
  last_seen: NOW - 2000,
  door_open_at: null,
  battery_since: null,
  comp_off_at: null,
  ...o,
});
const fridge = (l: LiveState | null): Pick<Fridge, 'live'> => ({ live: l });

describe('status shown = the server classification (shared status vectors)', () => {
  it.each(vectors.status.map((v) => [v.expected, v] as const))('%s', (expected) => {
    const status = fridgeStatus(fridge(live({ state: expected as LiveState['state'] })), NOW);
    expect(status).toBe(expected);
    const { container } = render(<StatusChip status={status} />);
    expect(container.textContent).toBe(STATUS[status].label); // word, not colour alone
    expect((container.firstChild as HTMLElement).style.color).toBe(STATUS[status].ink);
  });

  it('a silent or stale node reads OFFLINE, with how long it has been quiet', () => {
    expect(fridgeStatus(fridge(null), NOW)).toBe('OFFLINE');
    expect(fridgeStatus(fridge(live({ online: false })), NOW)).toBe('OFFLINE');
    expect(fridgeStatus(fridge(live({ last_seen: NOW - 19_000 })), NOW)).toBe('SAFE');
    expect(fridgeStatus(fridge(live({ last_seen: NOW - 21_000 })), NOW)).toBe('OFFLINE');
    expect(staleFor(fridge(live({ last_seen: NOW - 21_000 })), NOW)).toBe(21);
    expect(staleFor(fridge(live({ last_seen: NOW - 3000 })), NOW)).toBeNull();
  });
});

describe('door timer', () => {
  it('counts from the device event time and turns into an alarm after 60 s', () => {
    expect(doorState(fridge(live({ door: 0 })), NOW)).toEqual({ open: false, seconds: 0, alarm: false });
    expect(doorState(fridge(live({ door: 1, door_open_at: NOW_S - 59 })), NOW)).toMatchObject({
      open: true,
      alarm: false,
    });
    expect(doorState(fridge(live({ door: 1, door_open_at: NOW_S - 61 })), NOW)).toMatchObject({
      seconds: 61,
      alarm: true,
    });
  });
});

describe('compressor minimum off-time', () => {
  it('shows the seconds left before a restart is allowed', () => {
    expect(compressorState(fridge(live({ comp: 1 })), NOW)).toEqual({ on: true, restartInS: 0 });
    expect(compressorState(fridge(live({ comp: 0, comp_off_at: NOW_S - 18 })), NOW).restartInS).toBe(42);
    expect(compressorState(fridge(live({ comp: 0, comp_off_at: NOW_S - 75 })), NOW).restartInS).toBe(0);
    expect(compressorState(fridge(live({ comp: 0, comp_off_at: null })), NOW).restartInS).toBe(0);
  });
});

describe('heat budget bar', () => {
  it('green, amber from 50 %, orange below 20 % (At Risk), red at 0 (Discard)', () => {
    expect([100, 50, 49.9, 20, 19.9, 0.1, 0].map(budgetTone)).toEqual([
      'safe',
      'safe',
      'warning',
      'warning',
      'atrisk',
      'atrisk',
      'breach',
    ]);
    render(<BudgetBar remaining={12.4} />);
    const meter = screen.getByRole('meter', { name: 'Heat budget remaining' });
    expect(meter).toHaveAttribute('aria-valuenow', '12');
    expect(meter).toHaveAttribute('data-tone', 'atrisk');
  });

  it('accrual follows the contract thresholds: x1 above 8 °C, x2 above 12 °C', () => {
    expect(accrual(fridge(live({ temp: 8 })), NOW)).toBe('none');
    expect(accrual(fridge(live({ temp: 8.1 })), NOW)).toBe('x1');
    expect(accrual(fridge(live({ temp: 12 })), NOW)).toBe('x1');
    expect(accrual(fridge(live({ temp: 12.1 })), NOW)).toBe('x2');
    expect(accrual(fridge(live({ temp: null })), NOW)).toBe('x2');
    expect(accrual(fridge(null), NOW)).toBe('unknown');
  });
});

describe('fridge card', () => {
  async function renderCard(role: 'ADMIN' | 'PHARMACIST', l: LiveState, latch = false) {
    const { MemoryRouter } = await import('react-router-dom');
    const { Providers } = await import('../App');
    const { FakeSocket, mockApi, signIn } = await import('../test-utils');
    const { FridgeCard } = await import('./FridgeCard');
    const calls = mockApi({
      'GET /api/fridges/fridge-01/readings': { status: 200, body: { points: [], events: [], bucket: 30 } },
      'GET /api/auth/me': { status: 200, body: { user: { id: 1, email: 'x', name: 'T', role } } },
      'POST /api/fridges/fridge-01/reset-latch': {
        status: 200,
        body: { latch: false, changed: true, acknowledged_batches: [4], attempts: 1 },
      },
    });
    signIn(role);
    const f: Fridge = {
      id: 'fridge-01',
      name: 'Vaccine Fridge A',
      capacity: 20,
      latch,
      device_id: 'fridge-01',
      load: 3,
      batch_counts: { SAFE: 3, AT_RISK: 0, DISCARD: 0 },
      status: 'SAFE',
      live: l,
    };
    render(
      <MemoryRouter>
        <Providers connect={() => new FakeSocket()}>
          <FridgeCard fridge={f} now={NOW} />
        </Providers>
      </MemoryRouter>,
    );
    return calls;
  }

  it('shows the door alarm, battery, compressor off-timer and buffered sync', async () => {
    await renderCard(
      'PHARMACIST',
      live({
        door: 1,
        door_open_at: NOW_S - 75,
        power: 'BATTERY',
        batt: 64,
        comp: 0,
        comp_off_at: NOW_S - 18,
        buf: 37,
      }),
    );
    expect(screen.getByText('Open for 01:15 · alarm')).toBeInTheDocument();
    expect(screen.getByText(/Battery/)).toHaveTextContent('64 %');
    expect(screen.getByText('Off · off-timer 42 s until restart allowed')).toBeInTheDocument();
    expect(screen.getByText('buffered 37 readings, syncing…')).toBeInTheDocument();
  });

  it('latch banner: everyone sees it, only an Admin gets Reset', async () => {
    await renderCard('PHARMACIST', live({ latch: 1 }), true);
    expect(screen.getByRole('alert')).toHaveTextContent('DISCARD LATCH – admin reset required');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('Admin reset sends the reason and reports the result', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    const { calls } = await renderCard('ADMIN', live({ latch: 1 }), true);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    const confirm = screen.getByRole('button', { name: 'Acknowledge and reset' });
    expect(confirm).toBeDisabled(); // a reason is required
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'vials destroyed');
    await user.click(confirm);
    expect(await screen.findByText('Vaccine Fridge A: latch cleared')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.init.body as string)).toEqual({ reason: 'vials destroyed' });
  });
});
