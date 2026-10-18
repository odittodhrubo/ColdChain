import { z } from 'zod';
import { HMAC_WINDOW_S, NONCE_TTL_S } from './shared/constants';

const url = (protocols: string[]) =>
  z.url().refine((v) => protocols.includes(new URL(v).protocol), {
    message: `must use one of: ${protocols.join(', ')}`,
  });

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 random characters (run `npm run env:init`)'),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]?$/, 'must look like 3600, 15m, 1h or 7d')
      .default('1h'),
    BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
    DB_PATH: z.string().min(1).default('./data/coldchain.db'),
    APP_SECRET_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters = 32 bytes (run `npm run env:init`)'),
    PUBLIC_BASE_URL: url(['http:', 'https:']).default('http://localhost:5173'),
    CORS_ORIGIN: url(['http:', 'https:']).default('http://localhost:5173'),
    MQTT_URL: url(['mqtt:', 'mqtts:', 'ws:', 'wss:']),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    MQTT_TOPIC_PREFIX: z
      .string()
      .regex(/^[^#+]+[^/#+]$/, 'must be a plain topic path without wildcards or a trailing slash')
      .default('coldchain/v1'),
    HMAC_WINDOW_S: z.coerce.number().int().positive().default(HMAC_WINDOW_S),
    NONCE_TTL_S: z.coerce.number().int().positive().default(NONCE_TTL_S),
    DEMO_TIME_SCALE: z.coerce.number().min(1).default(1),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    ALERT_EMAIL_TO: z.email().optional(),
    ML_URL: url(['http:', 'https:']).default('http://localhost:8000'),
    ML_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000), // scheduler period (tests: faster)
  })
  // A nonce must be remembered for the whole accepted timestamp range (now ± window), or a replay slips through.
  .refine((c) => c.NONCE_TTL_S >= 2 * c.HMAC_WINDOW_S, {
    path: ['NONCE_TTL_S'],
    message: 'must be at least 2 × HMAC_WINDOW_S',
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

/** Parse and validate the environment. Empty values count as unset. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
