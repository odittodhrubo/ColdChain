import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // Never log credentials or tokens, wherever they appear.
  redact: ['req.headers.authorization', '*.password', '*.secret', '*.token'],
});

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/** Request id (from X-Request-Id or new), echoed back, and one log line per request. */
export const requestLog: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info(
      { reqId: req.id, method: req.method, url: req.originalUrl, status: res.statusCode, ms },
      'request',
    );
  });
  next();
};
