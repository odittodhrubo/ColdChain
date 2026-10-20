import http from 'node:http';
import { createApp } from './app';
import { openDb } from './db';
import { loadEnvOrExit } from './env';
import { startJobs } from './jobs';
import { startMqtt } from './mqtt/client';
import { attachSocketIO } from './realtime';
import type { AppContext } from './shared/http';
import { logger } from './shared/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadEnvOrExit();
const db = openDb(config.DB_PATH);
const app = createApp(config, db);
const ctx = app.locals.ctx as AppContext;

const server = app.listen(config.PORT, () => {
  logger.info(`backend listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});
ctx.realtime = attachSocketIO(server, ctx);
const mqtt = startMqtt(config, ctx.ingest);
ctx.mqttConnected = mqtt.connected;
ctx.simPublish = mqtt.publish; // demo simulation controls publish to the virtual node's sim topic
const stopJobs = startJobs(ctx);

// D3: /metrics for Prometheus, on a port of its own (the public API never serves it)
const metricsServer = config.METRICS_PORT
  ? http
      .createServer((req, res) => {
        if (req.url !== '/metrics') return void res.writeHead(404).end();
        ctx.metrics.registry
          .metrics()
          .then((body) => res.writeHead(200, { 'Content-Type': ctx.metrics.registry.contentType }).end(body))
          .catch(() => res.writeHead(500).end());
      })
      .listen(config.METRICS_PORT, config.METRICS_HOST, () =>
        logger.info(`metrics on http://${config.METRICS_HOST}:${config.METRICS_PORT}/metrics`),
      )
  : null;

let stopping = false;
function shutdown(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'shutting down');
  // Never hang: open keep-alive or WebSocket connections, or a broker that does not answer, would block exit.
  setTimeout(() => {
    logger.error({ reason }, `shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms: forcing exit`);
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  stopJobs(); // writes pending audit entries before anything else stops
  ctx.realtime.disconnectAll?.();
  metricsServer?.close();
  void mqtt
    .stop()
    .catch((err: Error) => logger.warn({ err: err.message }, 'mqtt stop failed'))
    .finally(() => {
      server.close(() => {
        db.close();
        process.exit(code);
      });
      server.closeAllConnections();
    });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A stray rejection is logged, not fatal: every job and handler already guards its own work.
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled promise rejection');
  ctx.reportError(err, { kind: 'unhandledRejection' });
});
// An exception that escaped every handler leaves the process in an unknown state: flush, then exit non-zero
// so the supervisor (Docker restart policy) starts a clean one.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  ctx.reportError(err, { kind: 'uncaughtException' });
  shutdown('uncaughtException', 1);
});
