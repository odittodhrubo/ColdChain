import { z } from 'zod';
import { conflict, notFound } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';
import { ALERT_TYPES, alertView, type AlertRow } from './service';

const int = z.coerce.number().int();

export function alertRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/alerts',
      access: { permission: 'dashboard:read' },
      query: z.strictObject({
        status: z.enum(['active', 'acknowledged', 'resolved', 'all']).default('all'),
        severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
        type: z.enum(ALERT_TYPES).optional(),
        fridge_id: z.string().max(64).optional(),
        page: int.min(1).default(1),
        pageSize: int.min(1).max(200).default(50),
      }),
      handler({ query }, { db }) {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (query.status === 'active') where.push('resolved_at IS NULL AND acknowledged_at IS NULL');
        if (query.status === 'acknowledged')
          where.push('resolved_at IS NULL AND acknowledged_at IS NOT NULL');
        if (query.status === 'resolved') where.push('resolved_at IS NOT NULL');
        for (const [col, v] of [
          ['severity', query.severity],
          ['type', query.type],
          ['fridge_id', query.fridge_id],
        ] as const)
          if (v !== undefined) {
            where.push(`${col} = ?`);
            args.push(v);
          }
        const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = db
          .prepare(`SELECT COUNT(*) FROM alerts ${filter}`)
          .pluck()
          .get(...args) as number;
        const rows = db
          .prepare(`SELECT * FROM alerts ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as AlertRow[];
        return { alerts: rows.map(alertView), page: query.page, pageSize: query.pageSize, total };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/alerts/:id/ack',
      access: { permission: 'alert:ack' },
      params: z.strictObject({ id: int.positive() }),
      handler: ({ params, user }, ctx) => ({ alert: ctx.alerts.ack(params.id, user!.id) }),
    }),

    // "Test buzzer": a signed BUZZER_TEST, tracked until the device's cmdack (poll GET /api/commands/:id).
    defineRoute({
      method: 'post',
      path: '/api/fridges/:id/buzzer-test',
      access: { permission: 'device:test' },
      params: z.strictObject({ id: z.string().min(1).max(64) }),
      handler({ params, res }, { db, commands }) {
        if (!db.prepare('SELECT 1 FROM fridges WHERE id = ?').get(params.id))
          throw notFound('Fridge not found');
        const deviceId = db
          .prepare(
            'SELECT device_id FROM devices WHERE fridge_id = ? AND active = 1 ORDER BY device_id LIMIT 1',
          )
          .pluck()
          .get(params.id) as string | undefined;
        const cmdId = deviceId ? commands.send(deviceId, 'BUZZER_TEST') : null;
        if (!cmdId) throw conflict('NO_DEVICE', 'No active device for this fridge');
        res.status(202).json({ command: commands.get(cmdId) });
      },
    }),

    defineRoute({
      method: 'get',
      path: '/api/commands/:id',
      access: { permission: 'dashboard:read' },
      params: z.strictObject({ id: z.uuid() }),
      handler({ params }, { commands }) {
        const command = commands.get(params.id);
        if (!command) throw notFound('Command not found');
        return { command };
      },
    }),
  ];
}
