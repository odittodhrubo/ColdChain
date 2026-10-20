import { describe, expect, it } from 'vitest';
import { envelope, NOW, setup, telemetry, topic } from './deviceHelpers';

// D3: Prometheus metrics move with ingest and HTTP traffic, and the public API never serves them.
describe('metrics', () => {
  it('count readings and rejects, read live gauges at scrape time, label HTTP by route pattern', async () => {
    const { ctx, ingest, t } = setup();
    ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1, { temp: 6.2 })), NOW);
    ingest.handle(topic('telemetry'), '{nope', NOW);
    await t.http().get('/api/fridges/fridge-01'); // unauthenticated: 401, still timed under its pattern

    const text = await ctx.metrics.registry.metrics();
    expect(text).toContain('coldchain_readings_total{fridge="fridge-01"} 1');
    expect(text).toContain('coldchain_rejects_total{reason="BAD_JSON"} 1');
    expect(text).toContain('coldchain_fridge_temp_c{fridge="fridge-01"} 6.2');
    expect(text).toMatch(/coldchain_last_reading_age_seconds\{fridge="fridge-01"\} \d/);
    expect(text).toContain(
      'coldchain_http_request_seconds_count{route="/api/fridges/:id",method="GET",status="401"} 1',
    );
    expect(text).not.toContain('route="/api/fridges/fridge-01"'); // raw paths never become labels
  });

  it('are not on the public API port', async () => {
    const { t } = setup();
    expect((await t.http().get('/metrics')).status).toBe(404);
    expect((await t.http().get('/api/metrics')).status).toBe(404);
  });
});
