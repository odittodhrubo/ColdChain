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
    // sign-in attempts (password and two-factor code) per client IP per minute; raise only for test rigs
    LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1000).default(10),
    DB_PATH: z.string().min(1).default('./data/coldchain.db'),
    APP_SECRET_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters = 32 bytes (run `npm run env:init`)'),
    PUBLIC_BASE_URL: url(['http:', 'https:']).default('http://localhost:5173'),
    CORS_ORIGIN: url(['http:', 'https:']).default('http://localhost:5173'),
    // Which reverse proxies may set X-Forwarded-For (Express "trust proxy"): the rate limiters and the audit log
    // must see the client, not the proxy. A hop count, or names / CIDRs, e.g. "loopback, 172.16.0.0/12" (Docker).
    TRUST_PROXY: z
      .string()
      .trim()
      .min(1)
      .default('loopback')
      .transform((v) => (/^\d+$/.test(v) ? Number(v) : v)),
    MQTT_URL: url(['mqtt:', 'mqtts:', 'ws:', 'wss:']),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    // Stable id + persistent session: the broker keeps the subscription and queues QoS 1 messages while the
    // backend restarts. Default coldchain-backend-<hostname>-<PORT>; two backends must never share one.
    MQTT_CLIENT_ID: z.string().min(1).max(128).optional(),
    // S3: when on, an Admin without TOTP can only set it up (and change their password) until it is on
    REQUIRE_ADMIN_MFA: z
      .enum(['0', '1', 'false', 'true'])
      .default('0')
      .transform((v) => v === '1' || v === 'true'),
    MQTT_TOPIC_PREFIX: z
      .string()
      .regex(/^[^#+]+[^/#+]$/, 'must be a plain topic path without wildcards or a trailing slash')
      .default('coldchain/v1'),
    HMAC_WINDOW_S: z.coerce.number().int().positive().default(HMAC_WINDOW_S),
    NONCE_TTL_S: z.coerce.number().int().positive().default(NONCE_TTL_S),
    DEMO_TIME_SCALE: z.coerce.number().min(1).default(1),
    // Demo simulation controls: let the web app drive the virtual node (open the door, change the temperature,
    // cut power/Wi-Fi) over an MQTT sim topic. OFF by default; `make demo` turns it on. A real device ignores it.
    SIM_CONTROLS: z
      .enum(['0', '1', 'true', 'false'])
      .default('false')
      .transform((v) => v === '1' || v === 'true'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    ALERT_EMAIL_TO: z.email().optional(),
    // P3: seconds an unacknowledged WARNING/CRITICAL alert may sit before it escalates once (a second,
    // flagged notification round). 0 turns escalation off. Keep it below the re-notify cooldowns to fire first.
    ESCALATE_AFTER_S: z.coerce.number().int().min(0).max(86400).default(600),
    // P2: local hours (0–23, comma-separated) to send the twice-daily temperature summary to the alert channels,
    // as the manual morning/evening reading would. Empty turns it off. Default 08:00 and 18:00 (WHO EVM practice).
    DAILY_SUMMARY_HOURS: z
      .string()
      .trim()
      .default('8,18')
      .refine((v) => v === '' || v.split(',').every((h) => /^\d{1,2}$/.test(h.trim()) && Number(h) < 24), {
        message: 'must be comma-separated hours 0–23, e.g. "8,18"',
      })
      .transform((v) => (v === '' ? [] : v.split(',').map((h) => Number(h.trim())))),
    ML_URL: url(['http:', 'https:']).default('http://localhost:8000'),
    // S8, optional: an RFC 3161 Time-Stamp Authority that also signs each audit anchor (e.g. https://freetsa.org/tsr)
    ANCHOR_TSA_URL: url(['https:']).optional(),
    // D4: error tracking (Sentry or GlitchTip DSN); off when unset
    ERROR_DSN: url(['https:', 'http:']).optional(),
    // D3: Prometheus metrics on their own port (off when unset), never on the public API port
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    METRICS_HOST: z.string().min(1).default('127.0.0.1'), // 0.0.0.0 inside a container, unpublished
    // P7: Web Push for BREACH/DOOR alerts, off unless both keys are set. Generate a pair with
    // `npx web-push generate-vapid-keys`. VAPID_SUBJECT is a mailto: or https: URL identifying the sender.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().min(1).default('mailto:ops@coldchain.local'),
    ML_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000), // scheduler period (tests: faster)
    // A1: the offline test MAE of the forecast (°C), from the ML report. The live rolling error is shown next to
    // it, and a sustained live error above FORECAST_DRIFT_FACTOR × this raises the "model needs retraining" signal.
    FORECAST_TEST_MAE: z.coerce.number().positive().default(0.66),
    FORECAST_DRIFT_FACTOR: z.coerce.number().min(1).default(2),
    // Online SQLite backups (R7): a consistent copy while the app writes, the newest BACKUP_KEEP kept.
    // Off-box copies are the deployment's job (docs/backend.md, "Backups").
    BACKUP_DIR: z.string().min(1).default('./data/backups'),
    BACKUP_EVERY_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(6 * 3600_000),
    BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(28), // 28 = 7 days at 6 h
    // Raw readings older than this are deleted once rolled up into readings_hourly (R8). At least 32 days, so
    // the chart's longest range (31 days ending now) is always raw data.
    READINGS_RETENTION_DAYS: z.coerce.number().int().min(32).max(3650).default(90),
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
