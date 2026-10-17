import { createApp } from './app';
import { openDb } from './db';
import { loadEnvOrExit } from './env';
import { startJobs } from './jobs';
import { startMqtt } from './mqtt/client';
import { attachSocketIO } from './realtime';
import type { AppContext } from './shared/http';
import { logger } from './shared/logger';

const config = loadEnvOrExit();
const db = openDb(config.DB_PATH);
const app = createApp(config, db);
const ctx = app.locals.ctx as AppContext;

const server = app.listen(config.PORT, () => {
  logger.info(`backend listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});
ctx.realtime = attachSocketIO(server, ctx);
const stopMqtt = startMqtt(config, ctx.ingest);
const stopJobs = startJobs(ctx);

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopJobs(); // writes pending audit entries before the process exits
  void stopMqtt().finally(() =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
