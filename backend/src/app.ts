import express from 'express';
import type { Config } from './config';

export function createApp(config: Config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'backend', env: config.NODE_ENV, demoScale: config.DEMO_TIME_SCALE });
  });

  return app;
}
