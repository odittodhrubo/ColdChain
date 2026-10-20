import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceEvent, Fridge, ReadingRow } from '../lib/types';
import { DEFAULT_ROUTES, mockApi, renderApp, signIn } from '../test-utils';
import './FridgeDetailPage'; // the route is lazy: load it up front

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const T0 = 1_800_000_000;
const reading = (i: number): ReadingRow => ({
  seq: 1000 - i,
  ts: T0 - i * 5,
  temp: 4 + i / 100,
  door: 0,
  comp: 1,
  power: 'MAINS',
  batt: 100,
  state: 'SAFE',
  late: 0,
  received_at: (T0 - i * 5) * 1000,
});
const event = (i: number): DeviceEvent => ({
  seq: 500 - i,
  ts: T0 - i * 60,
  type: i % 2 ? 'COMP_ON' : 'COMP_OFF',
  data: {},
  late: 0,
});
const fridge: Fridge = {
  id: 'fridge-01',
  name: 'Vaccine Fridge A',
  capacity: 20,
  latch: false,
  device_id: 'fridge-01',
  calibration_offset_c: 0,
  load: 0,
  batch_counts: { SAFE: 0, AT_RISK: 0, DISCARD: 0 },
  status: 'SAFE',
  live: null,
};

function open(readings: number, events: number) {
  mockApi({
    ...DEFAULT_ROUTES,
    'GET /api/fridges/fridge-01': {
      status: 200,
      body: {
        fridge,
        sim_controls: false,
        server_time: T0 * 1000,
        readings: Array.from({ length: readings }, (_, i) => reading(i)),
        events: Array.from({ length: events }, (_, i) => event(i)),
      },
    },
  });
  signIn('PHARMACIST');
  renderApp('/fridges/fridge-01');
}

const panel = async (title: string) =>
  (await screen.findByRole('heading', { name: title })).closest('section')!;

describe('fridge detail: recent readings and event timeline', () => {
  it('shows 15 readings per page and steps through the pages', async () => {
    open(40, 3);
    const readings = await panel('Recent readings');
    const rows = () => within(readings).getAllByRole('row').slice(1); // minus the header row
    expect(rows()).toHaveLength(15);
    expect(within(readings).getByText('1–15 of 40')).toBeInTheDocument();
    const prev = within(readings).getByRole('button', { name: 'Previous' });
    const next = within(readings).getByRole('button', { name: 'Next' });
    expect(prev).toBeDisabled();
    await userEvent.click(next);
    await userEvent.click(next);
    expect(within(readings).getByText('31–40 of 40')).toBeInTheDocument();
    expect(within(readings).getByText('Page 3 of 3')).toBeInTheDocument();
    expect(rows()).toHaveLength(10);
    expect(next).toBeDisabled();
    // the short timeline fits one page: no pager there
    const timeline = await panel('Event timeline');
    expect(within(timeline).queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('View all opens every loaded entry in a dialog', async () => {
    open(5, 32);
    const timeline = await panel('Event timeline');
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(15);
    await userEvent.click(within(timeline).getByRole('button', { name: 'View all (32)' }));
    const dialog = screen.getByRole('dialog', { name: 'Event timeline: all 32' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(32);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
