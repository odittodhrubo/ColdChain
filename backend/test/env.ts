/** A minimal valid environment for tests. */
export const validEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'x'.repeat(48),
  APP_SECRET_KEY: 'ab'.repeat(32),
  MQTT_URL: 'mqtt://localhost:1883',
  ESCALATE_AFTER_S: '0', // P3 escalation off unless a test opts in, so re-notify timings stay deterministic
};
