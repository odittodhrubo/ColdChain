// Prometheus metrics (D3), served on their own port (METRICS_PORT) and never on the public API: an operator alerts
// on "no reading from fridge-02 for 5 minutes" without opening the app. Labels stay bounded: fridges, reject
// reasons, route patterns (never raw paths with ids), and only batches that are still in stock.
import type { RequestHandler } from 'express';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { BUDGET_S } from './constants';
import type { AppContext } from './http';

export interface Metrics {
  registry: Registry;
  readings: Counter<'fridge'>;
  rejects: Counter<'reason'>;
  mlTick: Histogram;
  http: RequestHandler;
}

export function createMetrics(ctx: AppContext): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'coldchain_process_' });

  const readings = new Counter({
    name: 'coldchain_readings_total',
    help: 'Readings stored, live and synced',
    labelNames: ['fridge'] as const,
    registers: [registry],
  });
  const rejects = new Counter({
    name: 'coldchain_rejects_total',
    help: 'Device messages refused, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const mlTick = new Histogram({
    name: 'coldchain_ml_tick_seconds',
    help: 'One AI scheduler run over every fridge',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });
  const httpSeconds = new Histogram({
    name: 'coldchain_http_request_seconds',
    help: 'API latency by route pattern',
    labelNames: ['route', 'method', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [registry],
  });

  // gauges read the current state when Prometheus scrapes
  new Gauge({
    name: 'coldchain_last_reading_age_seconds',
    help: 'Seconds since the last accepted message from each fridge node',
    labelNames: ['fridge'] as const,
    registers: [registry],
    collect() {
      this.reset();
      const now = Date.now();
      for (const d of ctx.ingest.snapshot(now).devices) {
        const fridge = ctx.ingest.devices.get(d.device_id, now)?.fridgeId;
        if (fridge && d.last_seen) this.set({ fridge }, (now - d.last_seen) / 1000);
      }
    },
  });
  new Gauge({
    name: 'coldchain_fridge_temp_c',
    help: 'Latest temperature per fridge',
    labelNames: ['fridge'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const [fridge, live] of ctx.ingest.live) if (live.temp !== null) this.set({ fridge }, live.temp);
    },
  });
  new Gauge({
    name: 'coldchain_batch_remaining_ratio',
    help: 'Heat budget left per batch in stock (0..1)',
    labelNames: ['batch'] as const,
    registers: [registry],
    collect() {
      this.reset();
      const rows = ctx.db
        .prepare(
          `SELECT id, exposure_ms FROM batches WHERE deleted_at IS NULL AND quantity > 0 AND status != 'DISCARD'`,
        )
        .all() as { id: number; exposure_ms: number }[];
      for (const b of rows)
        this.set({ batch: String(b.id) }, Math.max(0, 1 - b.exposure_ms / (BUDGET_S * 1000)));
    },
  });

  const http: RequestHandler = (req, res, next) => {
    const end = httpSeconds.startTimer();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      end({ route, method: req.method, status: String(res.statusCode) });
    });
    next();
  };

  return { registry, readings, rejects, mlTick, http };
}
