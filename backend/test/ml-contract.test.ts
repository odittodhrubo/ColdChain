// Q4: the backend builds /predict requests by hand (src/ml/client.ts); the ML service validates them with
// Pydantic (ml/app/main.py, PredictIn). They are kept in sync by hand, so this validates the exact body the
// backend sends against the ML service's frozen OpenAPI schema (contracts/ml_openapi.json, written by
// tools/gen_ml_openapi.py, kept fresh by `gen_ml_openapi.py --check` in tools/test_all.js). A renamed, dropped
// or retyped field fails here instead of in the running system.
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import { httpPredict, type PredictRequest } from '../src/ml/client';

const openapi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../contracts/ml_openapi.json'), 'utf8'),
);
const ajv = new Ajv({ schemaId: 'auto' });
ajv.addSchema(openapi, 'ml');
const validatePredictIn = ajv.compile({ $ref: 'ml#/components/schemas/PredictIn' });

/** The request the AI scheduler produces for a fridge, before client.ts serialises it to the wire. */
const request: PredictRequest = {
  fridge_id: 'fridge-01',
  readings: [{ ts: 1_700_000_000, temp: 5.2, door: 0, comp: 0.5, battery: false, batt: 100 }],
  history_24h: [{ ts: 1_699_990_000, temp: 4.9, door: 0.1, comp: 0.3, battery: true, batt: 80 }],
  health_history: [{ ts: 1_699_990_000, score: 92 }],
};

async function sentBody(body: PredictRequest): Promise<unknown> {
  let captured: unknown;
  vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'insufficient_data' }), { status: 200 });
  });
  await httpPredict({ ML_URL: 'http://ml.test' } as Config)(body);
  return captured;
}

describe('backend /predict request matches the ML service schema', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the serialised request validates against PredictIn', async () => {
    const ok = validatePredictIn(await sentBody(request));
    expect(validatePredictIn.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it('a temp-only reading (null fields allowed) still validates', async () => {
    const body = { ...request, readings: [{ ts: 1_700_000_000, temp: null, door: 0, comp: 0, battery: false, batt: 100 }] };
    expect(validatePredictIn(await sentBody(body))).toBe(true);
  });

  it('the schema would reject a drifted field (guards the test itself)', () => {
    expect(validatePredictIn({ fridge_id: 'f', readings: [{ ts: 'not-a-number' }] })).toBe(false);
    expect(validatePredictIn({ fridge_id: 'f', readings: [], bogus: 1 })).toBe(false);
  });
});
