import type { AppContext } from '../shared/http';
import type { Prediction } from './types';

// A1: score the 30-minute forecasts against what really happened. Every scored row carries the observed
// temperature and the absolute error; the rolling error per fridge is shown on the AI Report page, and a
// sustained rise above the offline test error raises a FORECAST_DRIFT alert (the "retrain the model" signal).

const HORIZON_MS = 30 * 60_000;
const MATCH_TOLERANCE_S = 10 * 60; // the actual reading must be within 10 min of created_at + 30 min
const SCORE_BACK_MS = 25 * 3600_000; // only (re)score forecasts from the last 25 h, so retries stay bounded
const DRIFT_WINDOW_MS = 6 * 3600_000; // "exceeds 2× the test MAE for 6 hours"
const DRIFT_MIN_SCORED = 12; // enough scored forecasts in the window to judge drift

interface UnscoredRow {
  id: number;
  fridge_id: string;
  created_at: number;
  forecast: string;
}

/**
 * Fill actual_temp / abs_error for model forecasts made 30+ min ago that have a reading near their target time.
 * Only model predictions are scored (the rule-based fallback is a stopgap, not the model being measured).
 */
export function scoreForecasts(ctx: AppContext, nowMs = Date.now()): number {
  const rows = ctx.db
    .prepare(
      `SELECT id, fridge_id, created_at, forecast FROM ml_predictions
       WHERE source = 'model' AND actual_temp IS NULL AND created_at <= ? AND created_at >= ?
       ORDER BY created_at LIMIT 5000`,
    )
    .all(nowMs - HORIZON_MS, nowMs - SCORE_BACK_MS) as UnscoredRow[];
  const nearest = ctx.db
    .prepare(
      `SELECT temp FROM readings WHERE fridge_id = ? AND temp IS NOT NULL AND ts BETWEEN ? AND ?
       ORDER BY ABS(ts - ?) LIMIT 1`,
    )
    .pluck();
  const update = ctx.db.prepare('UPDATE ml_predictions SET actual_temp = ?, abs_error = ? WHERE id = ?');
  let scored = 0;
  const write = ctx.db.transaction(() => {
    for (const r of rows) {
      const pred = (JSON.parse(r.forecast) as Prediction).pred_temp_30;
      if (pred === null || pred === undefined) continue;
      const targetS = Math.round(r.created_at / 1000) + HORIZON_MS / 1000;
      const temp = nearest.get(
        r.fridge_id,
        targetS - MATCH_TOLERANCE_S,
        targetS + MATCH_TOLERANCE_S,
        targetS,
      ) as number | undefined;
      if (temp === undefined) continue; // no reading near the target yet (or ever, during an offline gap)
      update.run(temp, Math.abs(pred - temp), r.id);
      scored += 1;
    }
  });
  write();
  return scored;
}

/** Mean absolute error of scored model forecasts for a fridge over the window ending now. */
export function rollingMae(
  ctx: AppContext,
  fridgeId: string,
  windowMs: number,
  nowMs = Date.now(),
): { mae: number | null; n: number } {
  const r = ctx.db
    .prepare(
      `SELECT AVG(abs_error) AS mae, COUNT(*) AS n FROM ml_predictions
       WHERE fridge_id = ? AND source = 'model' AND abs_error IS NOT NULL AND created_at >= ?`,
    )
    .get(fridgeId, nowMs - windowMs) as { mae: number | null; n: number };
  return { mae: r.mae === null ? null : Math.round(r.mae * 1000) / 1000, n: r.n };
}

/** Per-fridge 24 h live error for the AI Report page, with the offline test MAE it is judged against. */
export function accuracy(ctx: AppContext, nowMs = Date.now()) {
  const fridges = ctx.db.prepare('SELECT id, name FROM fridges ORDER BY id').all() as {
    id: string;
    name: string;
  }[];
  const threshold = ctx.config.FORECAST_TEST_MAE * ctx.config.FORECAST_DRIFT_FACTOR;
  return {
    test_mae: ctx.config.FORECAST_TEST_MAE,
    drift_factor: ctx.config.FORECAST_DRIFT_FACTOR,
    horizon_min: HORIZON_MS / 60_000,
    fridges: fridges.map((f) => {
      const day = rollingMae(ctx, f.id, 24 * 3600_000, nowMs);
      return {
        fridge_id: f.id,
        name: f.name,
        mae_24h: day.mae,
        n_24h: day.n,
        drift: day.mae !== null && day.n >= DRIFT_MIN_SCORED && day.mae > threshold,
      };
    }),
  };
}

/**
 * Raise FORECAST_DRIFT (INFO) for a fridge whose 6 h rolling error stays above the factor × test MAE, and
 * resolve it once the error settles. Scoring runs first so the window is up to date.
 */
export function checkDrift(ctx: AppContext, nowMs = Date.now()) {
  const threshold = ctx.config.FORECAST_TEST_MAE * ctx.config.FORECAST_DRIFT_FACTOR;
  for (const f of ctx.db.prepare('SELECT id, name FROM fridges ORDER BY id').all() as {
    id: string;
    name: string;
  }[]) {
    const { mae, n } = rollingMae(ctx, f.id, DRIFT_WINDOW_MS, nowMs);
    if (mae !== null && n >= DRIFT_MIN_SCORED && mae > threshold)
      ctx.alerts.raise(
        {
          type: 'FORECAST_DRIFT',
          severity: 'INFO',
          fridgeId: f.id,
          title: `Forecast drifting: ${f.name}`,
          lines: [
            `Live 6 h error ${mae.toFixed(2)} °C is over ${ctx.config.FORECAST_DRIFT_FACTOR}× the test error ${ctx.config.FORECAST_TEST_MAE.toFixed(2)} °C (${n} forecasts)`,
            'The model may need retraining on recent data (see docs/ml.md).',
          ],
          data: { mae, test_mae: ctx.config.FORECAST_TEST_MAE, n },
        },
        nowMs,
      );
    else ctx.alerts.resolve('FORECAST_DRIFT', f.id, null, undefined, nowMs);
  }
}

/** Job: score due forecasts, then re-evaluate drift. */
export function scoringTick(ctx: AppContext, nowMs = Date.now()) {
  scoreForecasts(ctx, nowMs);
  checkDrift(ctx, nowMs);
}
