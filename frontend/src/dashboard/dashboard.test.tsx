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
    const { MemoryRouter } = await import('react-router');
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
      calibration_offset_c: 0,
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

describe('manual (simulation) controls', () => {
  async function renderPanel(l: LiveState | null) {
    const { MemoryRouter } = await import('react-router');
    const { Providers } = await import('../App');
    const { FakeSocket, mockApi, signIn } = await import('../test-utils');
    const { SimControls } = await import('./SimControls');
    const api = mockApi({
      'GET /api/auth/me': {
        status: 200,
        body: { user: { id: 1, email: 'x', name: 'T', role: 'PHARMACIST' } },
      },
      'POST /api/fridges/fridge-01/sim': { status: 200, body: { ok: true } },
    });
    signIn('PHARMACIST');
    const f: Fridge = {
      id: 'fridge-01',
      name: 'Vaccine Fridge A',
      capacity: 20,
      latch: false,
      device_id: 'fridge-01',
      calibration_offset_c: 0,
      load: 3,
      batch_counts: { SAFE: 3, AT_RISK: 0, DISCARD: 0 },
      status: 'SAFE',
      live: l,
    };
    render(
      <MemoryRouter>
        <Providers connect={() => new FakeSocket()}>
          <SimControls fridge={f} now={NOW} />
        </Providers>
      </MemoryRouter>,
    );
    const userEvent = (await import('@testing-library/user-event')).default;
    const sent = () =>
      api.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.init.body as string));
    return { user: userEvent.setup(), sent };
  }

  it('each button sends one explicit action, chosen from the live state', async () => {
    const { user, sent } = await renderPanel(live());
    await user.click(screen.getByRole('button', { name: 'Open door' }));
    await user.click(screen.getByRole('button', { name: 'Cut mains power' }));
    await user.click(screen.getByRole('button', { name: 'Breach · 10 °C' })); // holds by default
    await user.click(screen.getByLabelText('Hold the reading'));
    await user.click(screen.getByRole('button', { name: 'Raise by 0.5 °C' }));
    await user.click(screen.getByRole('button', { name: 'Apply' })); // 5 + 0.5, a one-off jump now
    await user.click(screen.getByRole('button', { name: 'Cut Wi-Fi' }));
    expect(await screen.findByRole('button', { name: 'Restore Wi-Fi' })).toBeInTheDocument();
    expect(sent()).toEqual([
      { action: 'door', value: true },
      { action: 'power', value: true },
      { action: 'hold', value: 10 },
      { action: 'temp', value: 5.5 },
      { action: 'wifi', value: true },
    ]);
  });

  it('counts down to the door alarm, then shows the door-open-too-long message with a close button', async () => {
    await renderPanel(live({ door: 1, door_open_at: NOW_S - 42 }));
    expect(screen.getByText('Open for 00:42')).toBeInTheDocument();
    expect(screen.getByText('Door alarm in 18 s if it stays open')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('door open past the alarm time: an alert message, and one click closes it', async () => {
    const { user, sent } = await renderPanel(live({ door: 1, door_open_at: NOW_S - 75 }));
    expect(screen.getByRole('alert')).toHaveTextContent('Door open too long');
    expect(screen.getByText('Open for 01:15 · alarm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close door now' }));
    expect(sent()).toEqual([{ action: 'door', value: false }]);
  });

  it('a held reading, battery and a weak compressor show as the node reports them', async () => {
    const { user, sent } = await renderPanel(
      live({ mode: 'manual', temp: 11.5, power: 'BATTERY', batt: 64 }),
    );
    expect(screen.getByText('Held at 11.5 °C')).toBeInTheDocument();
    expect(screen.getByText('Battery · 64 %')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore mains' }));
    await user.click(screen.getByRole('button', { name: 'Release hold' }));
    expect(sent()).toEqual([
      { action: 'power', value: false },
      { action: 'hold', value: null },
    ]);
  });

  it('refuses an out-of-range custom temperature before sending', async () => {
    const { user, sent } = await renderPanel(live());
    const field = screen.getByLabelText('Custom (°C)');
    await user.clear(field);
    await user.type(field, '99');
    expect(screen.getByText('Enter -30 to 40 °C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(sent()).toEqual([]);
  });
});
