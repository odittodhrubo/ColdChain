import path from 'node:path';
import dotenv from 'dotenv';
import { ConfigError, loadConfig, type Config } from './config';

/** .env normally lives at the repo root; a backend/.env takes precedence when present. Exits on invalid env. */
export function loadEnvOrExit(): Config {
  dotenv.config({ path: [path.resolve('.env'), path.resolve('..', '.env')], quiet: true });
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
