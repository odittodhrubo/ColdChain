import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../App';
import type { Role } from '../auth/permissions';
import type { Prediction, RelocationPlan } from '../lib/types';
import { forecastPoints } from '../pages/FridgeDetailPage';
import { DEFAULT_ROUTES, FakeSocket, mockApi, signIn } from '../test-utils';
import { AiPanel } from './AiPanel';
import { forecastSentence, PredictionMeta, RiskBadge } from './Forecast';
import { bandOf, healthFactors } from './HealthGauge';
import { PlanCard } from './RelocationPanel';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const NOW = 1_800_000_000_000;
const prediction = (o: Partial<Prediction> = {}): Prediction => ({
  fridge_id: 'fridge-01',
  created_at: NOW - 10_000,
  source: 'model',
  stale: false,
  at: NOW / 1000 - 60,
  pred_temp_30: 5.2,
  p10: 4.1,
  p90: 6.3,
  breach_level: 'LOW',
  breach_prob: 0.02,
  minutes_to_breach_estimate: null,
  health_score: 91,
  health_band: 'GOOD',
  health_method: 'model',
  health_trend_per_day: null,
  weakening: false,
  features_used: { temp_now: 5.0 },
  health_factors: { cool_rate_on: 0.58, duty_24: 0.5, cycles_per_hour: 4.3, n_cycles: 13 },
  model_version: '2026-10-18T13:22:00Z',
  ...o,
});

const wrap = (ui: ReactNode, role: Role = 'PHARMACIST') => {
  signIn(role);
  return render(
    <MemoryRouter>
      <Providers connect={() => new FakeSocket()}>{ui}</Providers>
    </MemoryRouter>,
  );
};
const me = (role: Role) => ({
  'GET /api/auth/me': { status: 200, body: { user: { id: 1, email: 'x', name: 'T', role } } },
});

describe('forecast', () => {
  it.each([
    ['LOW', prediction(), /Low risk/, /staying within 2–8 °C/],
    [
      'MEDIUM',
      prediction({ breach_level: 'MEDIUM', pred_temp_30: 7.1, p90: 8.6, minutes_to_breach_estimate: 24 }),
      /Medium risk/,
      /may exceed 8 °C in ~24 min/,
    ],
    [
      'HIGH',
      prediction({ breach_level: 'HIGH', pred_temp_30: 8.9, p90: 9.8, minutes_to_breach_estimate: 18 }),
      /High risk/,
      /Forecast 8\.9 °C in 30 min – may exceed 8 °C in ~18 min/,
    ],
  ] as const)('%s: badge word and the one-line why', (_level, p, badge, sentence) => {
    render(<RiskBadge level={p.breach_level} />);
    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(forecastSentence(p)).toMatch(sentence);
  });

  it('a fallback or old forecast is labelled, never shown as live', () => {
    const { rerender } = render(
      <PredictionMeta p={prediction({ source: 'fallback', stale: true })} now={NOW} />,
    );
    expect(screen.getByText(/rule-based fallback/)).toBeInTheDocument();
    rerender(<PredictionMeta p={prediction({ created_at: NOW - 5 * 60_000 })} now={NOW} />);
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText(/updated 5 min/)).toBeInTheDocument();
  });

  it('the chart overlay: last reading to +30 min, never from an old forecast', () => {
    const points = [{ ts: 1000, temp: 5, min: 5, max: 5, door: 0, comp: 0, battery: 0, late: 0 }];
    const fc = forecastPoints(points, prediction(), NOW);
    expect(fc.map((p) => [p.ts, p.fc, p.band])).toEqual([
      [1000, 5, [5, 5]],
      [2800, 5.2, [4.1, 6.3]],
    ]);
    expect(forecastPoints(points, prediction({ created_at: NOW - 10 * 60_000 }), NOW)).toEqual([]);
  });

  it('the fridge panel shows the forecast and the health gauge with its why', async () => {
    vi.setSystemTime(NOW);
    const latest = prediction({ health_score: 62, health_band: 'WEAKENING', weakening: true });
    mockApi({
      ...DEFAULT_ROUTES,
      'GET /api/ml/predictions/fridge-01': {
        status: 200,
        body: { predictions: [latest], latest, server_time: NOW },
      },
    });
    wrap(<AiPanel fridgeId="fridge-01" now={NOW} />);
    expect(await screen.findByText(/Forecast 5\.2 °C in 30 min/)).toBeInTheDocument();
    expect(screen.getByText(/80 % likely between 4\.1 and 6\.3 °C/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Health 62 of 100, Weakening' })).toBeInTheDocument();
    expect(screen.getByText('Weakening compressor – service recommended')).toBeInTheDocument();
    expect(screen.getByText(/It ran 50 % of the time over the last day/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('health bands and factors', () => {
    expect([0, 49, 50, 79, 80, 100].map((s) => bandOf(s).label)).toEqual([
      'Failing', 'Failing', 'Weakening', 'Weakening', 'Good', 'Good',
    ]); // prettier-ignore
    expect(healthFactors(prediction({ health_method: 'insufficient', health_factors: {} }))).toEqual([
      'Not enough compressor data yet to judge',
    ]);
  });
});

const plan = (o: Partial<RelocationPlan> = {}): RelocationPlan => ({
  id: '0f3c6c8e-8f0a-4a8e-9a55-1d2f3e4a5b6c',
  status: 'PROPOSED',
  version: 1,
  from_fridge: 'fridge-01',
  from_fridge_name: 'Vaccine Fridge A',
  risk: 'forecast 8.9 °C in 30 min (up to 9.8 °C)',
  rationale: 'Vaccine Fridge A: forecast 8.9 °C in 30 min. Moving 2 batches: 2 to Vaccine Fridge B.',
  advice: null,
  moves: [
    { batch_id: 7, batch_name: 'Measles-Rubella', lot_number: 'MR-1', remaining_pct: 18, to_fridge: 'fridge-02', to_fridge_name: 'Vaccine Fridge B', urgency: 'HIGH', reason: '' },
    { batch_id: 8, batch_name: 'Polio bOPV', lot_number: 'PV-2', remaining_pct: 80, to_fridge: 'fridge-02', to_fridge_name: 'Vaccine Fridge B', urgency: 'LOW', reason: '' },
  ], // prettier-ignore
  unsaveable: [
    { batch_id: 9, batch_name: 'Old Rabies', lot_number: 'RB-1', reason: 'dispose, cannot be saved' },
  ],
  shortfall: [],
  targets: [{ id: 'fridge-02', name: 'Vaccine Fridge B', p90: 6.4, health: 90, free: 12 }],
  rejected_targets: [],
  created_at: NOW - 60_000,
  updated_at: NOW - 60_000,
  expires_at: NOW + 14 * 60_000,
  decided_at: null,
  decided_by: null,
  decision_note: null,
  ...o,
});

describe('relocation plan', () => {
  it('names each batch, its destination and urgency; pharmacist confirms with one click', async () => {
    const { calls } = mockApi({
      ...DEFAULT_ROUTES,
      ...me('PHARMACIST'),
      'POST /api/relocations': { status: 200, body: { plan: plan({ status: 'CONFIRMED' }), already: false } },
    });
    wrap(<PlanCard plan={plan()} now={NOW} />);
    const table = screen.getByRole('table', { name: 'Proposed moves' });
    expect(within(table).getAllByText('Vaccine Fridge B')).toHaveLength(2);
    expect(within(table).getByText('Move first')).toBeInTheDocument();
    expect(
      screen.getByText(/Vaccine Fridge A may become unsafe because forecast 8\.9 °C/),
    ).toBeInTheDocument();
    expect(screen.getByText('Old Rabies')).toBeInTheDocument();
    expect(screen.getByText('expires in 14:00')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm relocation' }));
    expect(await screen.findByText('Relocation confirmed: 2 batches moved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the audit entry' })).toHaveAttribute(
      'href',
      '/audit?type=RELOCATION_CONFIRMED',
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/api/relocations/${plan().id}/confirm`);
    expect(JSON.parse(String(post.init.body))).toEqual({ version: 1 });
  });

  it('409: explains what changed and nothing is claimed as moved', async () => {
    const refreshed = plan({
      status: 'NO_SAFE_TARGET',
      version: 2,
      moves: [],
      advice: 'Move the batches to a portable cooler.',
    });
    mockApi({
      ...DEFAULT_ROUTES,
      ...me('ADMIN'),
      'POST /api/relocations': {
        status: 409,
        body: {
          error: {
            code: 'PLAN_CHANGED',
            message: 'Conditions changed',
            details: {
              plan: refreshed,
              problems: ['Vaccine Fridge B is no longer safe (forecast up to 8.3 °C)'],
            },
          },
        },
      },
    });
    wrap(<PlanCard plan={plan()} now={NOW} />, 'ADMIN');
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm relocation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The situation changed, so nothing was moved');
    expect(alert).toHaveTextContent('Vaccine Fridge B is no longer safe');
    expect(screen.queryByText(/Relocation confirmed/)).toBeNull();
  });

  it('an inspector reads the plan but has no confirm button', async () => {
    mockApi({ ...DEFAULT_ROUTES, ...me('INSPECTOR') });
    wrap(<PlanCard plan={plan()} now={NOW} />, 'INSPECTOR');
    expect(await screen.findByText(/Read only: an Admin or Pharmacist confirms/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm relocation' })).toBeNull();
  });

  it('no safe target: strong warning, the refused fridges and the advice (snapshot)', () => {
    mockApi({ ...DEFAULT_ROUTES, ...me('PHARMACIST') });
    const none = plan({
      status: 'NO_SAFE_TARGET',
      moves: [],
      unsaveable: [],
      targets: [],
      advice:
        'Move the batches to a portable cooler or a nearby site now, keep the door shut and check the fridge.',
      rejected_targets: [{ id: 'fridge-02', name: 'Vaccine Fridge B', why: 'forecast up to 7.9 °C' }],
    });
    const { container } = wrap(<PlanCard plan={none} now={NOW} />);
    expect(
      screen.getByRole('heading', { name: 'No safe fridge for the batches in Vaccine Fridge A' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm relocation' })).toBeNull();
    expect(container.querySelector('article')!.textContent).toMatchSnapshot();
  });
});
