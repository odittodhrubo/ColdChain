import { z } from 'zod';
import { REJECT_REASONS } from '../../mqtt/ingest';
import { defineRoute, type RouteDef } from '../../shared/http';

const int = z.coerce.number().int();

export function securityRoutes(): RouteDef[] {
  return [
    // Rejected device messages (P09): one row per message, with a hash of the payload, never the payload.
    defineRoute({
      method: 'get',
      path: '/api/security/events',
      access: { permission: 'audit:read' },
      query: z.strictObject({
        reason: z.enum(REJECT_REASONS).optional(),
        device_id: z.string().max(64).optional(),
        page: int.min(1).default(1),
        pageSize: int.min(1).max(200).default(50),
      }),
      handler({ query }, { db }) {
        const conditions = (
          [
            ['reason = ?', query.reason],
            ['device_id = ?', query.device_id],
          ] as const
        ).filter(([, v]) => v !== undefined);
        const args = conditions.map(([, v]) => v as string);
        const filter = conditions.length ? `WHERE ${conditions.map(([c]) => c).join(' AND ')}` : '';
        const total = db
          .prepare(`SELECT COUNT(*) FROM security_events ${filter}`)
          .pluck()
          .get(...args) as number;
        const rows = db
          .prepare(`SELECT * FROM security_events ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as { detail: string | null }[];
        return {
          events: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      },
    }),

    // Ingestion counters (Admin / Inspector): accepted by kind, rejected by reason, per-device state and gaps.
    defineRoute({
      method: 'get',
      path: '/api/metrics/ingest',
      access: { permission: 'metrics:read' },
      handler: (_in, { ingest }) => ingest.snapshot(),
    }),
  ];
}
