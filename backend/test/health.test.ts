import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

describe('GET /api/health', () => {
  it('responds ok', async () => {
    const res = await makeApp().http().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'backend', demoScale: 1 });
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
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
