import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { notificationPrefsSchema } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { Notification } from '../models/notifications';
import * as account from '../services/account';
import * as svc from '../services/notifications';

export const NOTIFICATION_PREFIXES = ['/notifications', '/push'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const pushSub = z.object({
  endpoint: z.string().url().max(600),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

const MAX_STREAMS_PER_USER = 3;
const streams = new Map<string, number>();

export function notificationsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/notifications',
    validate({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        before: id24.optional(),
        unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { limit: number; before?: string; unread?: boolean };
      res.set('Cache-Control', 'no-store').json(
        await svc.list(authedUser(req).userId, { limit: q.limit, before: q.before, unreadOnly: q.unread }),
      );
    }),
  );

  r.get(
    '/notifications/unread-count',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ unread: await svc.unreadCount(authedUser(req).userId) });
    }),
  );

  r.post(
    '/notifications/read-all',
    asyncHandler(async (req, res) => {
      res.json(await svc.markAllRead(authedUser(req).userId));
    }),
  );

  r.post(
    '/notifications/:id/read',
    validate({ params: z.object({ id: id24 }) }),
    asyncHandler(async (req, res) => {
      res.json(await svc.markRead(authedUser(req).userId, String(req.params.id)));
    }),
  );

  r.get(
    '/notifications/preferences',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await svc.preferences(ctx, authedUser(req).userId));
    }),
  );
  r.put(
    '/notifications/preferences',
    validate({ body: notificationPrefsSchema }),
    asyncHandler(async (req, res) => {
      const userId = authedUser(req).userId;
      await account.setNotificationPrefs(userId, req.body);
      res.json(await svc.preferences(ctx, userId));
    }),
  );

  r.post(
    ['/notifications/push', '/push/subscribe'],
    validate({ body: pushSub }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await svc.subscribePush(ctx, authedUser(req).userId, req.body, req.get('user-agent')));
    }),
  );
  r.post(
    '/notifications/push/remove',
    validate({ body: z.object({ endpoint: z.string().url().max(600) }) }),
    asyncHandler(async (req, res) => {
      res.json(await svc.unsubscribePush(authedUser(req).userId, req.body.endpoint));
    }),
  );

  /**
   * Server-sent events: the app learns of new notifications the moment they are written, by
   * watching the collection. The client falls back to polling /unread-count if this drops.
   */
  r.get(
    '/notifications/stream',
    asyncHandler(async (req, res) => {
      const userId = authedUser(req).userId;
      if ((streams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many open tabs', requestId: String(req.id) } });
        return;
      }
      streams.set(userId, (streams.get(userId) ?? 0) + 1);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(`event: ready\ndata: ${JSON.stringify({ unread: await svc.unreadCount(userId) })}\n\n`);

      const watcher = Notification.watch(
        [
          {
            $match: {
              operationType: { $in: ['insert', 'update'] },
              'fullDocument.userId': new Types.ObjectId(userId),
            },
          },
        ],
        { fullDocument: 'updateLookup' },
      );
      watcher.on('change', () => {
        void svc
          .unreadCount(userId)
          .then((unread) => {
            if (!res.writableEnded) res.write(`event: notify\ndata: ${JSON.stringify({ unread })}\n\n`);
          })
          .catch(() => undefined);
      });
      watcher.on('error', () => res.end());
      const beat = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 25_000);

      req.on('close', () => {
        clearInterval(beat);
        void watcher.close().catch(() => undefined);
        const n = (streams.get(userId) ?? 1) - 1;
        if (n <= 0) streams.delete(userId);
        else streams.set(userId, n);
      });
    }),
  );
  return r;
}

/** One-click unsubscribe from an email link. No session needed: the signed token is the proof. */
export function unsubscribeRouter(ctx: AppContext): Router {
  const r = Router();
  r.post(
    '/unsubscribe',
    validate({ body: z.object({ token: z.string().min(10).max(300) }) }),
    asyncHandler(async (req, res) => {
      res.json(await svc.unsubscribe(ctx, req.body.token));
    }),
  );
  return r;
}
