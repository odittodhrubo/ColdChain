import type { Request, RequestHandler, Response, Router } from 'express';
import { z, type ZodType } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db';
import type { AuditLog } from '../modules/audit/service';
import type { BatchView } from '../modules/batches/service';
import type { HeatEngine } from '../modules/exposure/engine';
import type { AlertEngine } from '../modules/alerts/service';
import type { PushSender } from '../modules/push/service';
import type { CommandTracker } from '../mqtt/commands';
import type { Ingestor } from '../mqtt/ingest';
import type { Realtime } from '../realtime';
import { can, type Permission, type Role } from '../rbac/permissions';
import { forbidden, unauthenticated } from './errors';
import type { BatchStatus } from './status';
import type { MlEngine } from '../ml/engine';
import type { RelocationEngine } from '../modules/relocation/service';
import type { ReportError } from './errorReport';
import type { Metrics } from './metrics';

// Route registry. Every route declares who may call it; there is no default, so a route cannot be added
// without a permission decision (deny by default). The RBAC test iterates this registry.

export type Access = 'public' | 'authenticated' | { permission: Permission };

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role; // always re-read from the DB on each request, never trusted from the token alone
  jti: string;
  exp: number;
  mustChangePassword?: boolean; // S2
  totpEnabled?: boolean; // S3
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Shared services handed to every handler. Later modules extend it. */
export interface AppContext {
  db: Db;
  config: Config;
  audit: AuditLog;
  realtime: Realtime; // replaced by Socket.IO in index.ts; silent in tests
  ingest: Ingestor;
  heat: HeatEngine; // heat-exposure budget (P11)
  alerts: AlertEngine; // alerts and notifications (P12)
  commands: CommandTracker; // signed device commands tracked until cmdack (P12)
  ml: MlEngine; // scheduled forecasts and health scores (P18)
  relocation: RelocationEngine; // relocation plans, one-click confirm (P18)
  hooks: AppHooks;
  mqttConnected?: () => boolean; // set by index.ts once the broker client starts; absent in tests
  simPublish?: (topic: string, payload: string) => void; // raw MQTT publish for demo simulation controls
  metrics: Metrics; // Prometheus (D3), served on METRICS_PORT only
  reportError: ReportError; // error tracking (D4), a no-op without ERROR_DSN
  push: PushSender; // Web Push for BREACH/DOOR alerts (P7), off without VAPID keys
}

/** Cross-module callbacks, wired in app.ts. The alert engine (P12) subscribes here. */
export interface AppHooks {
  batchStatusChanged?: (batch: BatchView, from: BatchStatus, to: BatchStatus) => void;
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface HandlerInput<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  user: AuthUser | undefined;
  req: Request;
  res: Response;
}

export interface RouteDef {
  method: Method;
  path: string;
  access: Access;
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  middleware?: RequestHandler[];
  handler: (input: HandlerInput<any, any, any>, ctx: AppContext) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const empty = z.strictObject({});

export function defineRoute<
  B extends ZodType = typeof empty,
  Q extends ZodType = typeof empty,
  P extends ZodType = typeof empty,
>(def: {
  method: Method;
  path: string;
  access: Access;
  body?: B;
  query?: Q;
  params?: P;
  middleware?: RequestHandler[];
  handler: (input: HandlerInput<z.output<B>, z.output<Q>, z.output<P>>, ctx: AppContext) => unknown;
}): RouteDef {
  if (def.path.includes(':') && !def.params)
    throw new Error(`${def.path}: routes with path params need a params schema`);
  return def as RouteDef;
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthenticated());
    if (!can(req.user.role, permission)) return next(forbidden());
    next();
  };
}

/** Mounts routes in order: route middleware, authentication, permission, validation (strict), handler. */
export function mountRoutes(
  router: Router,
  routes: RouteDef[],
  ctx: AppContext,
  authenticate: RequestHandler,
) {
  for (const r of routes) {
    const chain: RequestHandler[] = [...(r.middleware ?? [])];
    if (r.access !== 'public') chain.push(authenticate);
    if (typeof r.access === 'object') chain.push(requirePermission(r.access.permission));
    chain.push(async (req, res) => {
      const input = {
        body: (r.body ?? empty).parse(req.body ?? {}),
        query: (r.query ?? empty).parse(req.query ?? {}),
        params: (r.params ?? empty).parse(req.params ?? {}),
        user: req.user,
        req,
        res,
      };
      const out = await r.handler(input, ctx);
      if (out !== undefined && !res.headersSent) res.json(out);
    });
    router[r.method](r.path, ...chain);
  }
}
