import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { HttpError } from '../../shared/errors';
import { defineRoute, type RouteDef } from '../../shared/http';

const idParams = z.strictObject({ id: z.uuid() });

export function relocationRoutes(): RouteDef[] {
  // confirm moves stock: a burst of clicks or a script gets throttled long before it matters
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'RATE_LIMITED', 'Too many requests, try again soon')),
  });
  return [
    defineRoute({
      method: 'get',
      path: '/api/relocations',
      access: { permission: 'dashboard:read' },
      query: z.strictObject({
        status: z.enum(['active', 'all']).default('active'),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      handler: ({ query }, ctx) => ({ plans: ctx.relocation.list(query), server_time: Date.now() }),
    }),
    defineRoute({
      method: 'get',
      path: '/api/relocations/:id',
      access: { permission: 'dashboard:read' },
      params: idParams,
      handler: ({ params }, ctx) => ({ plan: ctx.relocation.get(params.id), server_time: Date.now() }),
    }),
    defineRoute({
      method: 'post',
      path: '/api/relocations/:id/confirm',
      access: { permission: 'relocation:confirm' },
      middleware: [limiter],
      params: idParams,
      body: z.strictObject({ version: z.number().int().positive() }), // optimistic lock: the version you saw
      handler: ({ params, body, user }, ctx) => ctx.relocation.confirm(params.id, body.version, user!.id),
    }),
    defineRoute({
      method: 'post',
      path: '/api/relocations/:id/dismiss',
      access: { permission: 'relocation:confirm' },
      middleware: [limiter],
      params: idParams,
      body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
      handler: ({ params, body, user }, ctx) => ({
        plan: ctx.relocation.dismiss(params.id, body.reason, user!.id),
      }),
    }),
  ];
}
