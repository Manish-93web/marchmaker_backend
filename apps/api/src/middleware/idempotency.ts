import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors';
import { IdempotencyKey } from '../models/social';

const TTL_MS = 24 * 3_600_000;

/**
 * Makes a POST safe to retry. The client sends `Idempotency-Key`; the first request runs and its
 * successful response is stored, and any repeat with the same key gets that exact response back.
 * A repeat while the first is still running gets 409, and reusing a key for a different body
 * gets 422. Failed requests are not stored, so the client can fix the problem and retry.
 */
export function idempotent(routeName: string, opts: { required?: boolean } = {}): RequestHandler {
  const required = opts.required ?? true;
  return async (req, res, next) => {
    try {
      const key = req.get('idempotency-key')?.trim();
      const userId = req.auth?.userId;
      if (!userId) return next();
      if (!key && !required) return next();
      if (!key || key.length < 8 || key.length > 100) {
        throw new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'Please retry. This request needs an Idempotency-Key header.');
      }
      const scope = `${routeName}:${String(req.params.id ?? '')}`;
      const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

      try {
        await IdempotencyKey.create({ userId, key, route: scope, requestHash, expiresAt: new Date(Date.now() + TTL_MS) });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        const prior = await IdempotencyKey.findOne({ userId, key, route: scope }).lean();
        if (!prior) return next(new AppError(409, 'IN_PROGRESS', 'This request is already being processed'));
        if (prior.requestHash !== requestHash) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'That key was already used for a different request');
        }
        if (prior.state === 'done') {
          res.setHeader('Idempotent-Replay', 'true');
          res.status(prior.responseStatus ?? 200).json(prior.responseBody);
          return;
        }
        throw new AppError(409, 'IN_PROGRESS', 'This request is already being processed');
      }

      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const done = ok
          ? IdempotencyKey.updateOne({ userId, key, route: scope }, { $set: { state: 'done', responseStatus: res.statusCode, responseBody: body } })
          : IdempotencyKey.deleteOne({ userId, key, route: scope });
        void done.catch(() => undefined);
        return json(body);
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
