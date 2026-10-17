/** A minimal valid environment for tests. */
export const validEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'x'.repeat(48),
  APP_SECRET_KEY: 'ab'.repeat(32),
  MQTT_URL: 'mqtt://localhost:1883',
};
