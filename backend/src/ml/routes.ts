import { z } from 'zod';
import { notFound } from '../shared/errors';
import { defineRoute, type RouteDef } from '../shared/http';
import { mlGet } from './client';
import { fromRow, type PredictionRow } from './engine';
import { accuracy } from './scoring';

const FIGURE = /^[a-z_]+\.png$/;

export function mlRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/ml/predictions/:fridgeId',
      access: { permission: 'dashboard:read' },
      params: z.strictObject({ fridgeId: z.string().min(1).max(64) }),
      query: z.strictObject({
        from: z.coerce.number().int().nonnegative().optional(), // unix ms
        to: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      }),
      handler({ params, query }, ctx) {
        if (!ctx.db.prepare('SELECT 1 FROM fridges WHERE id = ?').get(params.fridgeId))
          throw notFound('Fridge not found');
        const now = Date.now();
        const rows = ctx.db
          .prepare(
            `SELECT * FROM ml_predictions WHERE fridge_id = ? AND created_at >= ? AND created_at <= ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(
            params.fridgeId,
            query.from ?? now - 6 * 3600_000,
            query.to ?? now,
            query.limit,
          ) as PredictionRow[];
        return {
          predictions: rows.reverse().map(fromRow),
          latest: ctx.ml.latest(params.fridgeId),
          server_time: now,
        };
      },
    }),
    // A1: live forecast accuracy — rolling 24 h error per fridge, with the offline test MAE it is judged against.
    defineRoute({
      method: 'get',
      path: '/api/ml/accuracy',
      access: { permission: 'dashboard:read' },
      handler: (_in, ctx) => accuracy(ctx),
    }),
    defineRoute({
      method: 'get',
      path: '/api/ml/report',
      access: { permission: 'dashboard:read' },
      async handler(_in, { config }) {
        const r = (await (await mlGet(config, '/report')).json()) as { figures: string[] } & Record<
          string,
          unknown
        >;
        return { ...r, figures: r.figures.map((name) => ({ name, url: `/api/ml/report/figures/${name}` })) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/api/ml/report/figures/:name',
      access: { permission: 'dashboard:read' },
      params: z.strictObject({ name: z.string().regex(FIGURE) }),
      async handler({ params, res }, { config }) {
        const upstream = await mlGet(config, `/report/figures/${params.name}`);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(Buffer.from(await upstream.arrayBuffer()));
      },
    }),
  ];
}
