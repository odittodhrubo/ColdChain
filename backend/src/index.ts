import { createApp } from './app';
import { purgeRevoked } from './auth/tokens';
import { loadEnvOrExit } from './env';
import { openDb } from './db';
import { logger } from './shared/logger';

const config = loadEnvOrExit();
const db = openDb(config.DB_PATH);

// Housekeeping: revoked tokens are only needed until they would have expired anyway.
setInterval(() => purgeRevoked(db), 10 * 60_000).unref();

createApp(config, db).listen(config.PORT, () => {
  logger.info(`backend listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});
