import { z } from 'zod';
import { REJECT_REASONS } from '../../mqtt/ingest';
import { randomBytes } from 'node:crypto';
import { rotateSeal } from '../../mqtt/envelope';
import { CALIBRATION_MAX_C } from '../../shared/constants';
import { conflict, notFound } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';
import { encryptSecret } from '../../shared/secretbox';

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
            .prepare(
              `SELECT device_id, fridge_id, active, last_seen_at, pending_secret_enc IS NOT NULL AS rotation_pending,
                      secret_rotated_at FROM devices ORDER BY device_id`,
            )
            .all() as {
            device_id: string;
            fridge_id: string;
            active: number;
            last_seen_at: number | null;
            rotation_pending: number;
            secret_rotated_at: number | null;
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
            rotation_pending: d.rotation_pending === 1,
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

    // S7: a new device secret, generated here and never shown. It goes to the device sealed under the current
    // one; the device's first message signed with it completes the rotation (ingest promoteSecret).
    defineRoute({
      method: 'post',
      path: '/api/devices/:id/rotate-secret',
      access: { permission: 'device:manage' },
      params: z.strictObject({ id: z.string().min(1).max(64) }),
      body: z.strictObject({ reason: z.string().trim().min(3).max(200) }),
      handler({ params, body, user, res }, { db, config, ingest, commands, audit }) {
        const device = ingest.devices.get(params.id);
        if (!device) throw notFound('Device not found or disabled');
        // Never replace a pending secret: if the first command reached the device, it would switch to a key the
        // server had forgotten and be locked out. Recovery for a node that never got it: re-seed its secret.
        if (device.pendingSecret)
          throw conflict('ROTATION_PENDING', 'A rotation is waiting for this device to confirm it');
        const next = randomBytes(32).toString('hex');
        db.prepare('UPDATE devices SET pending_secret_enc = ? WHERE device_id = ?').run(
          encryptSecret(next, config.APP_SECRET_KEY),
          device.deviceId,
        );
        ingest.devices.invalidate(device.deviceId);
        const cmdId = commands.send(device.deviceId, 'ROTATE_SECRET', rotateSeal(device.secret, next));
        audit.append(`user:${user!.id}`, 'DEVICE_SECRET_ROTATED', {
          device_id: device.deviceId,
          phase: 'requested',
          reason: body.reason,
          cmd_id: cmdId,
        });
        res.status(202);
        return { device_id: device.deviceId, cmd_id: cmdId, status: 'PENDING' };
      },
    }),

    // P4: sensor calibration. A signed SET_CALIBRATION {offset_c} to the device (Admin only, bounded, with a
    // reason). The device applies it before classify() and acknowledges; the mirrored offset shows on fridge detail.
    defineRoute({
      method: 'post',
      path: '/api/devices/:id/calibrate',
      access: { permission: 'device:manage' },
      params: z.strictObject({ id: z.string().min(1).max(64) }),
      body: z.strictObject({
        offset_c: z.coerce.number().min(-CALIBRATION_MAX_C).max(CALIBRATION_MAX_C).multipleOf(0.1),
        reason: z.string().trim().min(3).max(200),
      }),
      handler({ params, body, user, res }, { db, ingest, commands, audit }) {
        const device = ingest.devices.get(params.id);
        if (!device) throw notFound('Device not found or disabled');
        const offset = Math.round(body.offset_c * 10) / 10;
        const cmdId = commands.send(device.deviceId, 'SET_CALIBRATION', { offset_c: offset });
        if (!cmdId) throw conflict('NO_DEVICE', 'No active device for this fridge');
        db.prepare('UPDATE devices SET calibration_offset_c = ? WHERE device_id = ?').run(offset, device.deviceId);
        audit.append(`user:${user!.id}`, 'DEVICE_CALIBRATED', {
          device_id: device.deviceId,
          offset_c: offset,
          reason: body.reason,
          cmd_id: cmdId,
        });
        res.status(202).json({ device_id: device.deviceId, offset_c: offset, command: commands.get(cmdId) });
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
