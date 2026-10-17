import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app';
import { ConfigError, loadConfig, type Config } from './config';

// .env normally lives at the repo root; a backend/.env takes precedence when present.
dotenv.config({ path: [path.resolve('.env'), path.resolve('..', '.env')], quiet: true });

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

createApp(config).listen(config.PORT, () => {
  console.log(`backend listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});
