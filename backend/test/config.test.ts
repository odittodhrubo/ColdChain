import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { HMAC_WINDOW_S } from '../src/shared/constants';
import { validEnv } from './env';

describe('loadConfig', () => {
  it('accepts a valid env and applies defaults from contracts', () => {
    const c = loadConfig(validEnv);
    expect(c.PORT).toBe(4000);
    expect(c.BCRYPT_COST).toBe(12);
    expect(c.HMAC_WINDOW_S).toBe(HMAC_WINDOW_S);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...validEnv, SMTP_PORT: '', ALERT_EMAIL_TO: '' }).SMTP_PORT).toBeUndefined();
  });

  it('rejects the .env.example placeholders with readable errors', () => {
    const bad = {
      ...validEnv,
      JWT_SECRET: 'change-me-long-random',
      APP_SECRET_KEY: '32-byte-hex-for-encrypting-device-secrets',
    };
    expect(() => loadConfig(bad)).toThrow(ConfigError);
    expect(() => loadConfig(bad)).toThrow(/JWT_SECRET[\s\S]*APP_SECRET_KEY|APP_SECRET_KEY[\s\S]*JWT_SECRET/);
  });

  it('.env.example with generated secrets (npm run env:init) loads, on the local broker make demo starts', () => {
    const example = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
    const env = Object.fromEntries(
      example
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_0-9]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const c = loadConfig({ ...env, JWT_SECRET: 'ab'.repeat(48), APP_SECRET_KEY: 'cd'.repeat(32) });
    // A placeholder cloud host here gave a fresh clone a demo with no live data (quick-start test, 2026-10-18).
    expect(['localhost', '127.0.0.1']).toContain(new URL(c.MQTT_URL).hostname);
  });

  it('rejects missing MQTT_URL and wrong protocols', () => {
    const noMqtt: Record<string, string> = { ...validEnv };
    delete noMqtt.MQTT_URL;
    expect(() => loadConfig(noMqtt)).toThrow(/MQTT_URL/);
    expect(() => loadConfig({ ...validEnv, MQTT_URL: 'http://broker:1883' })).toThrow(/MQTT_URL/);
  });

  it('rejects a nonce TTL shorter than the replay window', () => {
    expect(() => loadConfig({ ...validEnv, HMAC_WINDOW_S: '30', NONCE_TTL_S: '40' })).toThrow(/NONCE_TTL_S/);
  });

  it('rejects wildcard topic prefixes', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_TOPIC_PREFIX: 'coldchain/#' })).toThrow(/MQTT_TOPIC_PREFIX/);
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to loopback, takes a hop count as a number and a list as text', () => {
    expect(loadConfig(validEnv).TRUST_PROXY).toBe('loopback');
    expect(loadConfig({ ...validEnv, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: 'loopback, 172.16.0.0/12' }).TRUST_PROXY).toBe(
      'loopback, 172.16.0.0/12',
    );
  });
});
