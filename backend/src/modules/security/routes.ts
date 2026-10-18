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

    // The security page's tiles (every role that may read security events): last hour accepted vs rejected,
    // rejects by reason, and each device's last accepted message and open seq gap.
    defineRoute({
      method: 'get',
      path: '/api/security/summary',
      access: { permission: 'audit:read' },
      handler(_in, { db, ingest }) {
        const now = Date.now();
        const since = Math.floor((now - 3600_000) / 1000);
        const count = (sql: string, ...a: number[]) =>
          db
            .prepare(sql)
            .pluck()
            .get(...a) as number;
        const accepted =
          count('SELECT COUNT(*) FROM readings WHERE received_at >= ?', now - 3600_000) +
          count('SELECT COUNT(*) FROM events WHERE received_at >= ?', now - 3600_000);
        const byReason = db
          .prepare(
            'SELECT reason, COUNT(*) AS n FROM security_events WHERE ts >= ? GROUP BY reason ORDER BY n DESC',
          )
          .all(since) as { reason: string; n: number }[];
        const gaps = new Map(ingest.snapshot(now).devices.map((d) => [d.device_id, d.open_gap]));
        const devices = (
          db
            .prepare('SELECT device_id, fridge_id, active, last_seen_at FROM devices ORDER BY device_id')
            .all() as {
            device_id: string;
            fridge_id: string;
            active: number;
            last_seen_at: number | null;
          }[]
        ).map((d) => {
          // clock skew = server receipt time - device timestamp on its last live reading (sync excluded):
          // the usual cause of STALE_TS on demo day when a laptop, Wokwi or the broker host drifts
          const last = db
            .prepare(
              'SELECT ts, received_at FROM readings WHERE device_id = ? AND late = 0 AND seeded = 0 ORDER BY id DESC LIMIT 1',
            )
            .get(d.device_id) as { ts: number; received_at: number } | undefined;
          return {
            ...d,
            active: d.active === 1,
            open_gap: gaps.get(d.device_id) ?? null,
            clock_skew_s: last ? Math.round(last.received_at / 1000 - last.ts) : null,
          };
        });
        return {
          window_s: 3600,
          accepted,
          rejected: byReason.reduce((a, r) => a + r.n, 0),
          by_reason: byReason,
          devices,
          server_time: now,
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
