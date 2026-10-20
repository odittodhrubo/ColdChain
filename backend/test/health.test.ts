import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { mqttClientId, mqttOptions } from '../src/mqtt/client';
import type { AppContext } from '../src/shared/http';
import { makeApp } from './helpers';

describe('GET /api/health', () => {
  it('responds ok', async () => {
    const res = await makeApp().http().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'backend', demoScale: 1 });
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
  });
});

describe('GET /api/ready', () => {
  const ctxOf = (t: ReturnType<typeof makeApp>) => t.app.locals.ctx as AppContext;

  it('is ready with a working database before the broker client exists (tests, tools)', async () => {
    const res = await makeApp().http().get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: true,
      status: 'ok',
      checks: {
        db: 'ok',
        mqtt: 'not started',
        ingest: { last_message_age_s: null },
        ml: { state: 'idle', last_model_age_s: null },
      },
    });
  });

  it('answers 503 while the broker connection is down, 200 once it is back', async () => {
    const t = makeApp();
    let up = false;
    ctxOf(t).mqttConnected = () => up;
    const down = await t.http().get('/api/ready');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ ready: false, status: 'down', checks: { mqtt: 'disconnected' } });
    up = true;
    const ok = await t.http().get('/api/ready');
    expect(ok.status).toBe(200);
    expect(ok.body.checks.mqtt).toBe('connected');
  });

  it('answers 503 when the database fails', async () => {
    const t = makeApp();
    t.db.close();
    const res = await t.http().get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe('fail');
  });

  it('is only degraded (still 200) when the ML service is down: the rule-based fallback answers', async () => {
    const t = makeApp();
    const now = Date.now();
    ctxOf(t).ml.lastModelAt = now - 120_000;
    ctxOf(t).ml.lastFallbackAt = now - 1000;
    const res = await t.http().get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ready: true,
      status: 'degraded',
      checks: { ml: { state: 'fallback' } },
    });
    expect(res.body.checks.ml.last_model_age_s).toBeGreaterThanOrEqual(120);
  });
});

describe('MQTT session', () => {
  it('uses a stable client id and a persistent session, so the broker queues QoS 1 messages across restarts', () => {
    const { config } = makeApp();
    const opts = mqttOptions(config);
    expect(opts.clean).toBe(false);
    expect(opts.clientId).toBe(`coldchain-backend-${os.hostname()}-${config.PORT}`);
    expect(mqttOptions(config).clientId).toBe(opts.clientId); // same on every start
    expect(mqttClientId(makeApp({ MQTT_CLIENT_ID: 'site-a-backend' }).config)).toBe('site-a-backend');
  });
});

describe('error format', () => {
  it('unknown routes, malformed JSON and oversized bodies all use {error:{code,message}}', async () => {
    const t = makeApp();
    const missing = await t.http().get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });

    const malformed = await t
      .http()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('BAD_REQUEST');

    const big = await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'a@b.cd', password: 'x'.repeat(120_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets security headers and restricts CORS to CORS_ORIGIN', async () => {
    const res = await makeApp().http().get('/api/health').set('Origin', 'http://evil.example');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
