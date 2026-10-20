import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisplayPage } from './DisplayPage';
import { mockApi } from '../test-utils';

const fridge = {
  id: 'fridge-01',
  name: 'Fridge A',
  capacity: 20,
  latch: false,
  device_id: 'fridge-01',
  calibration_offset_c: 0,
  load: 2,
  batch_counts: { SAFE: 2, AT_RISK: 0, DISCARD: 0 },
  status: 'SAFE',
  live: { temp: 5.1 },
};

describe('DisplayPage (P1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
    sessionStorage.clear();
  });

  it('prompts for a link when there is no token', () => {
    render(<DisplayPage />);
    expect(screen.getByText(/Open this screen from the display link/i)).toBeInTheDocument();
  });

  it('polls with the Bearer token and shows fridges and active alerts', async () => {
    window.location.hash = '#token=aaa.bbb.ccc';
    const { calls } = mockApi({
      'GET /api/fridges': { status: 200, body: { fridges: [fridge] } },
      'GET /api/alerts': {
        status: 200,
        body: { alerts: [{ id: 1, severity: 'CRITICAL', message: 'x', data: { title: 'Temperature outside' } }] },
      },
    });
    render(<DisplayPage />);
    expect(await screen.findByText('Fridge A')).toBeInTheDocument();
    expect(await screen.findByText(/5\.1°/)).toBeInTheDocument();
    expect(await screen.findByText('Temperature outside')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((c) => (c.init.headers as Record<string, string>)?.Authorization === 'Bearer aaa.bbb.ccc'),
      ).toBe(true),
    );
  });
});
