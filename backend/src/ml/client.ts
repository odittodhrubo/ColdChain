import type { Config } from '../config';
import { HttpError } from '../shared/errors';
import type { MinuteRow, Prediction } from './types';

export const PREDICT_TIMEOUT_MS = 1000; // the scheduler never waits longer than this per fridge

export interface PredictRequest {
  fridge_id: string;
  readings: MinuteRow[];
  history_24h: MinuteRow[];
  health_history: { ts: number; score: number }[];
}

export type PredictResult = Prediction | { status: 'insufficient_data' };
export type PredictFn = (body: PredictRequest) => Promise<PredictResult>;

const wire = (r: MinuteRow) => ({
  ts: r.ts,
  temp: r.temp,
  door: r.door,
  comp: r.comp,
  power: r.battery ? 'BATTERY' : 'MAINS',
  batt: r.batt,
});

/** POST /predict on the ML service; throws on timeout, network error or a non-2xx answer. */
export function httpPredict(config: Config): PredictFn {
  return async (body) => {
    const res = await fetch(new URL('/predict', config.ML_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        readings: body.readings.map(wire),
        history_24h: body.history_24h.map(wire),
      }),
      signal: AbortSignal.timeout(PREDICT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ML service answered ${res.status}`);
    return (await res.json()) as PredictResult;
  };
}

/** GET on the ML service for the report endpoints (proxied: the browser never talks to it directly). */
export async function mlGet(config: Config, path: string): Promise<Response> {
  try {
    const res = await fetch(new URL(path, config.ML_URL), { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) throw new HttpError(404, 'NOT_FOUND', 'Not found on the ML service');
    if (!res.ok) throw new Error(String(res.status));
    return res;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'ML_UNAVAILABLE', 'The ML service is not reachable');
  }
}
