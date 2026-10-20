import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { BUDGET_S } from '../../shared/constants';
import { HttpError, notFound } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';
import {
  assignmentHistory,
  createBatch,
  deleteBatch,
  getBatch,
  getBatchByToken,
  listBatches,
  moveBatch,
  updateBatch,
} from './service';

const int = z.coerce.number().int();
const idParams = z.strictObject({ id: int.positive() });
const fridgeId = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date(); // YYYY-MM-DD, compared as a UTC calendar date

const editable = {
  name: text(120),
  quantity: int.min(0).max(1_000_000),
  criticality: int.min(1).max(3),
  expiry_date: isoDate,
};

/** URL encoded in every QR code: the public check page of the web app. */
export const publicCheckUrl = (base: string, token: string) => `${base.replace(/\/+$/, '')}/check/${token}`;

const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** QR code with the batch name and lot as caption, so a printed label is readable without a scanner. */
async function qrSvg(url: string, caption: string[]): Promise<string> {
  const size = 256;
  const qr = (await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })).replace(
    '<svg ',
    `<svg x="0" y="0" width="${size}" height="${size}" `,
  );
  const height = size + 22 * caption.length + 8;
  const lines = caption
    .map(
      (line, i) =>
        `<text x="${size / 2}" y="${size + 18 + 22 * i}" text-anchor="middle" font-family="sans-serif" font-size="${i ? 13 : 15}"${i ? '' : ' font-weight="bold"'}>${xml(line)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}"><rect width="100%" height="100%" fill="#fff"/>${qr}${lines}</svg>`;
}

export function batchRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/batches',
      access: { permission: 'dashboard:read' },
      query: z.strictObject({
        fridge_id: fridgeId.optional(),
        status: z.enum(['SAFE', 'AT_RISK', 'DISCARD']).optional(),
        expiring_within_days: int.min(0).max(3650).optional(),
        q: z.string().trim().max(100).optional(),
        page: int.min(1).default(1),
        pageSize: int.min(1).max(200).default(50),
      }),
      handler({ query }, { db, config }) {
        const { page, pageSize, ...filters } = query;
        const all = listBatches(db, filters);
        return {
          batches: all.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: all.length,
          demoScale: config.DEMO_TIME_SCALE, // exposure is accelerated when != 1 (P11): the UI shows a banner
        };
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/batches',
      access: { permission: 'batch:write' },
      body: z.strictObject({
        ...editable,
        quantity: int.min(1).max(1_000_000),
        manufacturer: text(120),
        lot_number: text(64),
        fridge_id: fridgeId,
      }),
      handler({ body, user, res }, ctx) {
        res
          .status(201)
          .json({ batch: createBatch(ctx, body, user!.id), demoScale: ctx.config.DEMO_TIME_SCALE });
      },
    }),

    defineRoute({
      method: 'get',
      path: '/api/batches/:id',
      access: { permission: 'dashboard:read' },
      params: idParams,
      handler({ params }, { db, config }) {
        const batch = getBatch(db, params.id);
        return {
          batch,
          public_url: publicCheckUrl(config.PUBLIC_BASE_URL, batch.public_token), // what the QR encodes
          demoScale: config.DEMO_TIME_SCALE,
          assignments: assignmentHistory(db, params.id),
          exposure: {
            weighted_exposure_s: batch.weighted_exposure_s,
            remaining_pct: batch.remaining_pct,
            used_minutes: batch.used_minutes,
            budget_s: BUDGET_S,
            demoScale: config.DEMO_TIME_SCALE,
          },
        };
      },
    }),

    defineRoute({
      method: 'patch',
      path: '/api/batches/:id',
      access: { permission: 'batch:write' },
      params: idParams,
      body: z
        .strictObject(editable)
        .partial()
        .refine((b) => Object.keys(b).length > 0, 'nothing to update'),
      handler: ({ params, body, user }, ctx) => ({
        batch: updateBatch(ctx, params.id, body, user!.id),
        demoScale: ctx.config.DEMO_TIME_SCALE,
      }),
    }),

    // Admin removes a batch from the inventory with a reason (audited). Soft delete: the record stays, the
    // fridge slot frees, and a discarded batch still reads DISCARD on its QR.
    defineRoute({
      method: 'delete',
      path: '/api/batches/:id',
      access: { permission: 'batch:delete' },
      params: idParams,
      body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
      handler: ({ params, body, user }, ctx) => deleteBatch(ctx, params.id, user!.id, body.reason),
    }),

    defineRoute({
      method: 'post',
      path: '/api/batches/:id/move',
      access: { permission: 'batch:write' },
      params: idParams,
      body: z.strictObject({ to_fridge_id: fridgeId }),
      handler: ({ params, body, user }, ctx) => ({
        batch: moveBatch(ctx, params.id, body.to_fridge_id, user!.id),
        demoScale: ctx.config.DEMO_TIME_SCALE,
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/api/batches/:id/qr',
      access: { permission: 'dashboard:read' },
      params: idParams,
      query: z.strictObject({ format: z.enum(['svg', 'png']).default('svg') }),
      async handler({ params, query, res }, { db, config }) {
        const b = getBatch(db, params.id);
        const url = publicCheckUrl(config.PUBLIC_BASE_URL, b.public_token);
        res.setHeader('Content-Disposition', `inline; filename="batch-${b.id}-qr.${query.format}"`);
        if (query.format === 'png') {
          res.type('png').send(await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2 }));
        } else {
          res.type('image/svg+xml').send(await qrSvg(url, [b.name, `Lot ${b.lot_number}`]));
        }
      },
    }),
  ];
}

const TOKEN = /^[A-Za-z0-9_-]{12}$/;

/** The only unauthenticated data route besides login: whitelisted fields, generic 404, rate limited, no caching. */
export function publicBatchRoutes(): RouteDef[] {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'RATE_LIMITED', 'Too many requests, try again soon')),
  });
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  return [
    defineRoute({
      method: 'get',
      path: '/api/public/batch/:token',
      access: 'public',
      middleware: [noStore, limiter],
      params: z.strictObject({ token: z.string().max(64) }),
      handler({ params }, { db }) {
        const b = TOKEN.test(params.token) ? getBatchByToken(db, params.token) : null;
        if (!b) throw notFound(); // same body for malformed and unknown tokens
        const lastReading = b.fridge_id
          ? (db.prepare('SELECT MAX(ts) FROM readings WHERE fridge_id = ?').pluck().get(b.fridge_id) as
              number | null)
          : null;
        return {
          name: b.name,
          lot_number: b.lot_number,
          expiry_date: b.expiry_date,
          status: b.status,
          expired: b.expired,
          last_checked: new Date(lastReading ? lastReading * 1000 : b.updated_at).toISOString(),
        };
      },
    }),
  ];
}
