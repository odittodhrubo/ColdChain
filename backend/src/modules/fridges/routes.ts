import { z } from 'zod';
import { badRequest, notFound } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';
import { logger } from '../../shared/logger';
import { buildReport, reportCsv, reportHtml } from './report';
import { getFridge, listFridges, readingsHistory, recentEvents, recentReadings } from './service';

const idParams = z.strictObject({ id: z.string().min(1).max(64) });
const unix = z.coerce.number().int().min(0);
const simTemp = z.number().min(-30).max(40); // the DS18B20 slider's useful range, well past both alarm bands

// One value shape per action, so a bad click is a 400 here, not a silently ignored message at the node.
const simBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('door'), value: z.boolean() }), // true = open
  z.strictObject({ action: z.literal('ajar'), value: z.boolean() }), // left ajar: open, slow leak
  z.strictObject({ action: z.literal('temp'), value: simTemp }), // one-off jump; the compressor recovers
  z.strictObject({ action: z.literal('hold'), value: simTemp.nullable() }), // pin the reading; null releases
  z.strictObject({ action: z.literal('power'), value: z.boolean() }), // true = mains cut, on battery
  z.strictObject({ action: z.literal('wifi'), value: z.boolean() }), // true = Wi-Fi cut
  z.strictObject({ action: z.literal('eff'), value: z.number().min(0.2).max(1) }), // compressor efficiency
]);

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
        sim_controls: ctx.config.SIM_CONTROLS, // the demo control panel renders only when this is on
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

    // P2: a temperature record for inspection. CSV (hourly rows) or print-ready HTML (the user saves it as PDF,
    // so no headless browser and no dependency). Every export is appended to the audit chain.
    defineRoute({
      method: 'get',
      path: '/api/fridges/:id/report',
      access: { permission: 'dashboard:read' },
      params: idParams,
      query: z.strictObject({ from: unix, to: unix, format: z.enum(['csv', 'html']).default('csv') }),
      handler({ params, query, res, user }, ctx) {
        if (query.from >= query.to) throw badRequest('from must be before to');
        if (query.to - query.from > 366 * 86_400) throw badRequest('range is limited to one year');
        const report = buildReport(ctx, params.id, query.from, query.to); // 404 if the fridge is unknown
        ctx.audit.append(user ? `user:${user.id}` : 'system', 'REPORT_EXPORTED', {
          fridge: params.id,
          from: query.from,
          to: query.to,
          format: query.format,
        });
        if (query.format === 'csv')
          res
            .type('text/csv')
            .set('Content-Disposition', `attachment; filename="${params.id}_${query.from}_${query.to}.csv"`)
            .send(reportCsv(report));
        else res.type('html').send(reportHtml(report));
      },
    }),

    // Demo simulation controls: drive the virtual node like the Wokwi panel — open/close the door or leave it
    // ajar, jump or hold the temperature, cut mains power or Wi-Fi, weaken the compressor. Off unless
    // SIM_CONTROLS is set (a real device ignores the sim topic). Staff who may act on a device (device:test)
    // only: an Inspector or a wall display watches. Not audited: a demo stimulus, not a records-worthy change.
    defineRoute({
      method: 'post',
      path: '/api/fridges/:id/sim',
      access: { permission: 'device:test' },
      params: idParams,
      body: simBody,
      handler({ params, body, user }, ctx) {
        if (!ctx.config.SIM_CONTROLS) throw notFound('Simulation controls are off');
        const { device_id } = getFridge(ctx, params.id); // 404 if the fridge is unknown
        if (!device_id) throw badRequest('This fridge has no node to drive');
        if (!ctx.simPublish) throw badRequest('No broker connection for simulation controls');
        const topic = `${ctx.config.MQTT_TOPIC_PREFIX}/${device_id}/sim`; // the node listens on its device id
        ctx.simPublish(topic, JSON.stringify({ action: body.action, arg: body.value ?? null }));
        logger.info(
          { fridge: params.id, action: body.action, value: body.value, user: user?.id },
          'sim control',
        );
        return { ok: true, action: body.action };
      },
    }),
  ];
}
