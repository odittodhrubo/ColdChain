import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';

/** Every error response is {error:{code,message,details?}}. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission for this action') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('No such endpoint'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) err = badRequest('Invalid request', err.issues);
  // body-parser errors (malformed JSON, body too large) carry a status
  if (!(err instanceof HttpError) && typeof err?.status === 'number' && err.status < 500) {
    err = new HttpError(
      err.status,
      err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      'Malformed request',
    );
  }
  if (!(err instanceof HttpError)) {
    logger.error({ err, reqId: req.id }, 'unhandled error');
    err = new HttpError(500, 'INTERNAL', 'Internal server error');
  }
  const { status, code, message, details } = err as HttpError;
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
};
