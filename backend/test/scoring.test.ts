import { describe, expect, it } from 'vitest';
import { accuracy, rollingMae, scoreForecasts, scoringTick } from '../src/ml/scoring';
import { addReading, ctxOf, prediction, setPrediction } from './relocationHelpers';
import { addUser, bearer, makeApp, tokenFor } from './helpers';

const MIN = 60_000;

/** A fridge with a device so readings satisfy the FK. */
function fridgeWithDevice(t: ReturnType<typeof makeApp>, id = 'score-01') {
  t.db.prepare('INSERT INTO fridges (id, name, capacity, created_at) VALUES (?, ?, 20, 0)').run(id, 'Score A');
  t.db
    .prepare('INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES (?, ?, ?, 0)')
    .run(`dev-${id}`, id, 'x');
  return id;
}

describe('forecast scoring (A1)', () => {
  it('scores a forecast against the reading 30 min later and computes the absolute error', () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const now = 2_000_000_000_000;
    const id = fridgeWithDevice(t);
    const createdAt = now - 31 * MIN;
    setPrediction(t, id, prediction({ pred_temp_30: 5 }), createdAt);
    // the reading nearest created_at + 30 min read 6.5 °C
    addReading(t, id, { ts: Math.round(createdAt / 1000) + 30 * 60, temp: 6.5 });

    expect(scoreForecasts(ctx, now)).toBe(1);
    const row = t.db.prepare('SELECT actual_temp, abs_error FROM ml_predictions').get() as {
      actual_temp: number;
      abs_error: number;
    };
    expect(row.actual_temp).toBe(6.5);
    expect(row.abs_error).toBeCloseTo(1.5, 5);
    expect(rollingMae(ctx, id, 24 * 3600_000, now)).toEqual({ mae: 1.5, n: 1 });
    // a forecast with no reading near its target stays unscored
    setPrediction(t, id, prediction({ pred_temp_30: 5 }), now - 45 * MIN);
    expect(scoreForecasts(ctx, now)).toBe(0);
  });

  it('raises FORECAST_DRIFT when the live error stays above the factor × test MAE, by INFO', () => {
    const t = makeApp({ FORECAST_TEST_MAE: '0.5', FORECAST_DRIFT_FACTOR: '2' }); // threshold 1.0 °C
    const ctx = ctxOf(t);
    const now = 2_000_000_000_000;
    const id = fridgeWithDevice(t);
    for (let i = 0; i < 14; i++) {
      const createdAt = now - (40 + i * 10) * MIN; // all within the last 6 h
      setPrediction(t, id, prediction({ pred_temp_30: 5 }), createdAt);
      addReading(t, id, { ts: Math.round(createdAt / 1000) + 30 * 60, temp: 7 }); // error 2.0 °C
    }
    scoringTick(ctx, now);
    const alert = t.db
      .prepare("SELECT severity, resolved_at FROM alerts WHERE type = 'FORECAST_DRIFT' AND fridge_id = ?")
      .get(id) as { severity: string; resolved_at: number | null };
    expect(alert.severity).toBe('INFO');
    expect(alert.resolved_at).toBeNull();

    const acc = accuracy(ctx, now);
    expect(acc.test_mae).toBe(0.5);
    expect(acc.fridges.find((f) => f.fridge_id === id)).toMatchObject({ drift: true, n_24h: 14 });
  });

  it('does not flag drift when the error is within range, and the endpoint is readable', async () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const now = 2_000_000_000_000;
    const id = fridgeWithDevice(t);
    for (let i = 0; i < 14; i++) {
      const createdAt = now - (40 + i * 10) * MIN;
      setPrediction(t, id, prediction({ pred_temp_30: 5 }), createdAt);
      addReading(t, id, { ts: Math.round(createdAt / 1000) + 30 * 60, temp: 5.3 }); // error 0.3 °C
    }
    scoringTick(ctx, now);
    expect(t.db.prepare("SELECT COUNT(*) FROM alerts WHERE type = 'FORECAST_DRIFT'").pluck().get()).toBe(0);

    const insp = bearer(tokenFor(t, await addUser(t, 'INSPECTOR')));
    const res = await t.http().get('/api/ml/accuracy').set(insp);
    expect(res.status).toBe(200);
    expect(res.body.fridges.find((f: { fridge_id: string }) => f.fridge_id === id).drift).toBe(false);
  });
});
