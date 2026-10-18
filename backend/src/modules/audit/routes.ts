import { z } from 'zod';
import { defineRoute, type RouteDef } from '../../shared/http';
import { AUDIT_EVENTS, verifyChain, type AuditRow, type VerifyResult } from './chain';

const intParam = z.coerce.number().int();
const flag = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');

export function auditRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/audit',
      access: { permission: 'audit:read' },
      query: z.strictObject({
        type: z.enum(AUDIT_EVENTS).optional(),
        actor: z.string().max(100).optional(),
        batch_id: intParam.positive().optional(), // entries about one batch (inventory details drawer)
        from: intParam.nonnegative().optional(), // unix ms
        to: intParam.nonnegative().optional(),
        page: intParam.min(1).default(1),
        pageSize: intParam.min(1).max(200).default(50),
      }),
      handler({ query }, { db, audit }) {
        audit.flush();
        const conditions = (
          [
            ['event_type = ?', query.type],
            ['actor = ?', query.actor],
            ["json_extract(payload, '$.batch_id') = ?", query.batch_id],
            ['ts >= ?', query.from],
            ['ts <= ?', query.to],
          ] as const
        ).filter(([, v]) => v !== undefined);
        const args = conditions.map(([, v]) => v as string | number);
        const filter = conditions.length ? `WHERE ${conditions.map(([c]) => c).join(' AND ')}` : '';
        const total = db
          .prepare(`SELECT COUNT(*) FROM audit_log ${filter}`)
          .pluck()
          .get(...args) as number;
        const rows = db
          .prepare(`SELECT * FROM audit_log ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as AuditRow[];
        return {
          entries: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      },
    }),

    defineRoute({
      method: 'get',
      path: '/api/audit/verify',
      access: { permission: 'audit:verify' },
      query: z.strictObject({ from: intParam.min(1).optional(), stream: flag.optional() }),
      async handler({ query, user, res }, { db, audit }) {
        audit.flush(); // queued entries belong to the chain being checked
        const record = (result: VerifyResult) => {
          // Logged after the check, so recording the verification can never change its own result.
          audit.append(`user:${user!.id}`, 'AUDIT_VERIFY', {
            valid: result.valid,
            checked: result.checked,
            from: query.from ?? 1,
            head_hash: result.headHash,
            ...(result.valid ? {} : { reason: result.reason, first_broken_id: result.firstBrokenId }),
          });
          return result;
        };
        if (!query.stream) return record(await verifyChain(db, { fromId: query.from }));

        // NDJSON: {"progress":{checked,total}} lines while verifying, then {"result":...}.
        res.status(200).type('application/x-ndjson');
        const result = await verifyChain(db, {
          fromId: query.from,
          onProgress: (checked, total) => res.write(`${JSON.stringify({ progress: { checked, total } })}\n`),
        });
        res.end(`${JSON.stringify({ result: record(result) })}\n`);
      },
    }),
  ];
}
