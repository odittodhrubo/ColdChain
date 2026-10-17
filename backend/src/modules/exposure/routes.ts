import { z } from 'zod';
import { BUDGET_S } from '../../shared/constants';
import { defineRoute, type RouteDef } from '../../shared/http';
import { getBatch } from '../batches/service';

const MAX_POINTS = 500;

export function exposureRoutes(): RouteDef[] {
  return [
    // Cumulative weighted exposure over time, for the batch chart (recomputed from readings, never cached).
    defineRoute({
      method: 'get',
      path: '/api/batches/:id/exposure',
      access: { permission: 'dashboard:read' },
      params: z.strictObject({ id: z.coerce.number().int().positive() }),
      handler({ params }, ctx) {
        const b = getBatch(ctx.db, params.id);
        const { points } = ctx.heat.computeExposure(params.id);
        const stride = Math.ceil(points.length / MAX_POINTS);
        const timeline = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
        return {
          batch_id: b.id,
          status: b.status,
          weighted_exposure_s: b.weighted_exposure_s,
          remaining_pct: b.remaining_pct,
          used_minutes: b.used_minutes,
          budget_s: BUDGET_S,
          demoScale: ctx.config.DEMO_TIME_SCALE,
          timeline,
        };
      },
    }),

    // Admin acknowledges the discarded batches and clears the red latch on the device (signed command + ack).
    defineRoute({
      method: 'post',
      path: '/api/fridges/:id/reset-latch',
      access: { permission: 'latch:reset' },
      params: z.strictObject({ id: z.string().min(1).max(64) }),
      body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
      handler: ({ params, body, user }, ctx) => ctx.heat.resetLatch(params.id, user!.id, body.reason),
    }),
  ];
}
