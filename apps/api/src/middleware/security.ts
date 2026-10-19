import type { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import { randomBytes } from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { Env } from '../config/env';

export function securityMiddleware(env: Env): RequestHandler[] {
  const nonce: RequestHandler = (_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  };

  return [
    nonce,
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: [(_req, res) => `'nonce-${(res as unknown as { locals: { cspNonce: string } }).locals.cspNonce}'`],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
    (_req, res, next) => {
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      next();
    },
    cors({
      origin(origin, cb) {
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'idempotency-key', 'if-match', 'x-request-id', 'x-app'],
      maxAge: 600,
    }),
    hpp(),
    mongoSanitize(),
  ];
}

/** Default global limiter; auth endpoints get stricter limiters in Phase 2. Redis store is wired when REDIS_URL is set. */
export function globalRateLimiter(env: Env, redis?: Redis | null): RequestHandler {
  return rateLimit({
    // Shared store so the limit holds across instances; if Redis fails, requests are allowed rather than blocked.
    ...(redis ? { store: new RedisStore({ sendCommand: (...args: string[]) => redis.call(args[0]!, ...args.slice(1)) as Promise<never> }), passOnStoreError: true } : {}),
    windowMs: 60_000,
    limit: env.NODE_ENV === 'test' ? 10_000 : 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.', requestId: req.id },
      });
    },
  });
}
