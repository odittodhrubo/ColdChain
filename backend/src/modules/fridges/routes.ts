import { z } from 'zod';
import { badRequest } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';
import { getFridge, listFridges, readingsHistory, recentEvents, recentReadings } from './service';

const idParams = z.strictObject({ id: z.string().min(1).max(64) });
const unix = z.coerce.number().int().min(0);

export function fridgeRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/fridges',
      access: { permission: 'dashboard:read' },
      handler: (_in, ctx) => ({
        fridges: listFridges(ctx),
        server_time: Date.now(), // clients derive "open for", "last seen" and staleness from server time
        demoScale: ctx.config.DEMO_TIME_SCALE,
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/api/fridges/:id',
      access: { permission: 'dashboard:read' },
      params: idParams,
      handler: ({ params }, ctx) => ({
        fridge: getFridge(ctx, params.id),
        events: recentEvents(ctx, params.id),
        readings: recentReadings(ctx, params.id),
        server_time: Date.now(),
      }),
    }),

    // ?from&to in unix s (default: the last hour); bucket in s, raised as needed to stay within 600 points.
    defineRoute({
      method: 'get',
      path: '/api/fridges/:id/readings',
      access: { permission: 'dashboard:read' },
      params: idParams,
      query: z.strictObject({
        from: unix.optional(),
        to: unix.optional(),
        bucket: z.coerce.number().int().min(1).max(86_400).optional(),
      }),
      handler({ params, query }, ctx) {
        const to = query.to ?? Math.floor(Date.now() / 1000);
        const from = query.from ?? to - 3600;
        if (from >= to) throw badRequest('from must be before to');
        if (to - from > 31 * 86_400) throw badRequest('range is limited to 31 days');
        return readingsHistory(ctx, params.id, { from, to, bucket: query.bucket });
      },
    }),
  ];
}
