import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { API_PREFIX } from '@marchmaker/shared';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { globalRateLimiter, securityMiddleware } from './middleware/security';
import { healthRouter } from './routes/health';
import { v1Router } from './routes/v1';
import { docsRouter } from './openapi';
import { kycWebhookRouter } from './routes/verification';
import { paymentsWebhookRouter } from './routes/billing';
import { callsWebhookRouter } from './routes/extras';
import { messagingWebhooksRouter } from './routes/messaging';
import { buildContext, type AppContext } from './context';
import { MemoryMailer } from './lib/mailer';
import { MemorySms } from './lib/sms';

export interface AppDeps {
  env: Env;
  log: Logger;
  isReady: () => boolean | Promise<boolean>;
  /** Provide to inject mailer/sms fakes; defaults to in-memory adapters. */
  ctx?: AppContext;
}

export function createApp({ env, log, isReady, ctx: given }: AppDeps): Express {
  const ctx = given ?? buildContext({ env, log, mailer: new MemoryMailer(log), sms: new MemorySms(log) });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (req as express.Request).id,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(securityMiddleware(env));

  // Health endpoints sit outside the rate limiter and the versioned prefix.
  app.use(healthRouter({ isReady, version: process.env.npm_package_version ?? '0.0.0' }));

  app.use(globalRateLimiter(env, ctx.redis));
  // Webhooks need the raw body for signature checks, so they mount before the JSON parser.
  app.use(`${API_PREFIX}/webhooks`, kycWebhookRouter(ctx));
  app.use(`${API_PREFIX}/webhooks`, paymentsWebhookRouter(ctx));
  app.use(`${API_PREFIX}/webhooks`, callsWebhookRouter(ctx));
  app.use(`${API_PREFIX}/webhooks`, messagingWebhooksRouter(ctx));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // OpenAPI is not served in production.
  if (env.NODE_ENV !== 'production') app.use('/api/docs', docsRouter());
  app.use(API_PREFIX, v1Router(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler(log, env.NODE_ENV === 'production'));
  return app;
}
