import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { validEnv } from './env';

describe('GET /api/health', () => {
  it('responds ok', async () => {
    const res = await request(createApp(loadConfig(validEnv))).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'backend', demoScale: 1 });
  });
});
