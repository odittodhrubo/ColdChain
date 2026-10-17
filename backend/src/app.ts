import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { authenticate } from './auth/middleware';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import type { Db } from './db';
import { auditRoutes } from './modules/audit/routes';
import { batchRoutes, publicBatchRoutes } from './modules/batches/routes';
import { AuditLog } from './modules/audit/service';
import { securityRoutes } from './modules/security/routes';
import { userRoutes } from './modules/users/routes';
import { Ingestor, type IngestHooks } from './mqtt/ingest';
import { HeatEngine } from './modules/exposure/engine';
import { exposureRoutes } from './modules/exposure/routes';
import { alertRoutes } from './modules/alerts/routes';
import { AlertEngine } from './modules/alerts/service';
import { CommandTracker } from './mqtt/commands';
import { silentRealtime } from './realtime';
import { errorHandler, notFoundHandler } from './shared/errors';
import { type AppContext, defineRoute, mountRoutes, type RouteDef } from './shared/http';
import { requestLog } from './shared/logger';

export function createApp(config: Config, db: Db) {
  const ctx = { config, db, audit: new AuditLog(db), realtime: silentRealtime, hooks: {} } as AppContext;
  ctx.ingest = new Ingestor(ctx); // fed by the MQTT client in index.ts, or directly in tests
  ctx.heat = new HeatEngine(ctx);
  ctx.alerts = new AlertEngine(ctx);
  // realtime is swapped for Socket.IO after start-up: always emit through the current one
  ctx.commands = new CommandTracker(db, ctx.ingest.sender, { emit: (e, d) => ctx.realtime.emit(e, d) });
  // Device pipeline fan-out: exposure first (it may change batch statuses), then alerts and command tracking.
  Object.assign(ctx.ingest.hooks, {
    onReadingsInserted: (fridgeId, readings, opts) => {
      ctx.heat.onReadings(fridgeId, readings, opts);
      ctx.alerts.onReadings(fridgeId, readings, opts);
    },
    onDeviceEvent: (fridgeId, event) => {
      ctx.heat.onDeviceEvent(fridgeId, event);
      ctx.alerts.onDeviceEvent(fridgeId, event);
    },
    onCommandAck: (deviceId, ack) => {
      ctx.heat.onCommandAck(deviceId, ack);
      ctx.commands.onAck(deviceId, ack);
    },
    onDeviceOffline: (fridgeId, deviceId, ms) => ctx.alerts.onDeviceOffline(fridgeId, deviceId, ms),
    onDeviceOnline: (fridgeId, deviceId) => ctx.alerts.onDeviceOnline(fridgeId, deviceId),
    onReject: (deviceId, reason, nowMs) => ctx.alerts.onReject(deviceId, reason, nowMs),
  } satisfies IngestHooks);
  ctx.hooks.batchStatusChanged = (batch, from, to) => ctx.alerts.onBatchStatus(batch, from, to);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // rate limiting sees the real client IP behind a local reverse proxy
  app.use(requestLog);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: false }));
  app.use(express.json({ limit: '100kb' }));

  const routes: RouteDef[] = [
    defineRoute({
      method: 'get',
      path: '/api/health',
      access: 'public',
      handler: () => ({
        status: 'ok',
        service: 'backend',
        env: config.NODE_ENV,
        demoScale: config.DEMO_TIME_SCALE,
      }),
    }),
    ...authRoutes(),
    ...userRoutes(),
    ...auditRoutes(),
    ...securityRoutes(),
    ...batchRoutes(),
    ...publicBatchRoutes(),
    ...exposureRoutes(),
    ...alertRoutes(),
  ];
  const router = express.Router();
  mountRoutes(router, routes, ctx, authenticate(ctx));
  app.use(router);
  app.locals.routes = routes; // the RBAC test iterates every registered route
  app.locals.ctx = ctx; // background jobs (index.ts) share the same services

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
