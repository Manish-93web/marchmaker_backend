import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { InvalidTransitionError } from '@marchmaker/shared';
import type { Logger } from 'pino';
import { AppError } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'We could not find that', requestId: req.id },
  });
};

export function errorHandler(log: Logger, isProd: boolean): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong on our side. Please try again.';
    let details: unknown;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof ZodError) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'Some details need your attention';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (err instanceof InvalidTransitionError) {
      status = 409;
      code = 'INVALID_STATE';
      message = 'That action is not available right now';
    } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      status = err.status;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      message = status === 413 ? 'That request is too large' : 'We could not read that request';
    }

    if (status >= 500) log.error({ err, requestId: req.id, path: req.path }, 'unhandled error');
    else log.debug({ code, requestId: req.id, path: req.path }, 'request rejected');

    if (res.headersSent) return;
    res.status(status).json({
      error: { code, message, ...(details !== undefined && { details }), requestId: req.id },
      ...(!isProd && status >= 500 && { debug: String(err?.message ?? err) }),
    });
  };
}
