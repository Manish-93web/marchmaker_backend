import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { NOTIFICATION_SPECS, type Role } from '@marchmaker/shared';
import { renderNotice } from '@marchmaker/email';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { WhatsAppTemplate } from '../models/messaging';
import { Delivery, Notification } from '../models/notifications';
import * as emailEvents from '../services/emailEvents';
import * as whatsapp from '../services/whatsapp';

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const headersOf = (req: Request) =>
  Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
const bad = (req: Request, code: string, message: string) => ({ error: { code, message, requestId: String(req.id) } });

/** Provider callbacks (raw body, so signatures cover the exact bytes). Mounted before the JSON parser. */
export function messagingWebhooksRouter(ctx: AppContext): Router {
  const r = Router();

  r.post(
    '/resend',
    express.raw({ type: '*/*', limit: '256kb' }),
    asyncHandler(async (req, res) => {
      const secret = ctx.env.RESEND_WEBHOOK_SECRET;
      if (!secret) {
        res.status(404).json(bad(req, 'NOT_FOUND', 'Not configured'));
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = headersOf(req);
      if (!emailEvents.verifySvix(secret, headers, raw)) {
        res.status(401).json(bad(req, 'INVALID_SIGNATURE', 'Invalid signature'));
        return;
      }
      let ev: { type?: string };
      try {
        ev = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json(bad(req, 'BAD_REQUEST', 'We could not read that request'));
        return;
      }
      if (ev.type) await emailEvents.handleResendEvent(ctx, headers['svix-id'] ?? '', ev as never);
      res.status(200).json({ received: true });
    }),
  );

  // Meta verifies the URL with a GET and then signs every POST.
  r.get(
    '/whatsapp',
    asyncHandler(async (req, res) => {
      // The mongo-sanitize middleware drops query keys containing a dot (hub.mode ...), so read the raw URL.
      const raw = Object.fromEntries(new URL(req.originalUrl, 'http://local').searchParams);
      res.status(200).type('text/plain').send(whatsapp.verifyChallenge(ctx, raw));
    }),
  );
  r.post(
    '/whatsapp',
    express.raw({ type: '*/*', limit: '256kb' }),
    asyncHandler(async (req, res) => {
      const secret = ctx.env.WHATSAPP_APP_SECRET;
      if (!secret) {
        res.status(404).json(bad(req, 'NOT_FOUND', 'Not configured'));
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!whatsapp.verifyMetaSignature(secret, raw, headersOf(req)['x-hub-signature-256'])) {
        res.status(401).json(bad(req, 'INVALID_SIGNATURE', 'Invalid signature'));
        return;
      }
      try {
        await whatsapp.handleWebhook(ctx, JSON.parse(raw.toString('utf8')));
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      // Meta retries anything that is not a 200, so acknowledge once the signature is good.
      res.status(200).json({ received: true });
    }),
  );
  return r;
}

const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

const templateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{3,60}$/),
  language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
  category: z.enum(['utility', 'authentication', 'marketing']).default('utility'),
  variables: z.number().int().min(0).max(10),
  body: z.string().max(1024).default(''),
  approvalStatus: z.enum(['draft', 'pending', 'approved', 'rejected']),
  purpose: z.string().max(200).default(''),
});

/** Messaging operations for staff: delivery logs, email suppression list, WhatsApp templates, copy preview. */
export function adminMessagingRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/notifications/deliveries',
    requirePermission('settings.manage'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z.enum(['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped']).optional(),
          channel: z.enum(['in_app', 'email', 'whatsapp', 'push']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const filter: Record<string, unknown> = {};
      if (q.status) filter.status = q.status;
      if (q.channel) filter.channel = q.channel;
      const rows = await Delivery.find(filter).sort({ _id: -1 }).limit(q.limit).lean();
      const notes = await Notification.find({ _id: { $in: rows.map((d) => d.notificationId) } }).select('type category').lean();
      const byId = new Map(notes.map((n) => [String(n._id), n]));
      res.set('Cache-Control', 'no-store').json({
        items: rows.map((d) => ({
          id: String(d._id),
          type: byId.get(String(d.notificationId))?.type ?? null,
          category: byId.get(String(d.notificationId))?.category ?? null,
          channel: d.channel,
          status: d.status,
          reason: d.reason ?? null,
          attempts: d.attempts,
          at: d.createdAt,
          sentAt: d.sentAt ?? null,
          deliveredAt: d.deliveredAt ?? null,
          error: d.error ?? null,
        })),
      });
    }),
  );

  /** What members receive for each event type, rendered with sample values. No member data is used. */
  r.get(
    '/notifications/catalog',
    requirePermission('settings.manage'),
    asyncHandler(async (_req, res) => {
      const sample = { introductionId: 'abc123', hoursLeft: 12, threadId: 't1', credits: 2, graceDays: 3, number: 'T-000123', ticketId: 't1', amountLabel: '₹200' };
      res.json({
        items: Object.entries(NOTIFICATION_SPECS).map(([type, s]) => ({
          type,
          category: s.category,
          critical: s.critical === true,
          channels: s.only ?? ['in_app', 'email', 'push', 'whatsapp'],
          copy: s.copy(sample),
        })),
      });
    }),
  );

  r.post(
    '/notifications/preview',
    requirePermission('settings.manage'),
    validate({ body: z.object({ type: z.string().max(60) }) }),
    asyncHandler(async (req, res) => {
      const s = NOTIFICATION_SPECS[req.body.type];
      if (!s) throw notFound('That message type does not exist');
      const copy = s.copy({ introductionId: 'abc123', hoursLeft: 12, threadId: 't1', credits: 2, graceDays: 3, number: 'T-000123', ticketId: 't1', amountLabel: '₹200' });
      const mail = await renderNotice({
        subject: copy.title,
        preview: copy.body,
        heading: copy.title,
        paragraphs: [copy.body],
        cta: { label: 'Open Marchmaker', url: `${ctx.env.APP_URL}${copy.url}` },
        ...(s.critical ? {} : { unsubscribeUrl: `${ctx.env.APP_URL}/unsubscribe?t=preview` }),
      });
      res.json({ subject: mail.subject, html: mail.html, text: mail.text });
    }),
  );

  r.get(
    '/email/suppressions',
    requirePermission('settings.manage'),
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await emailEvents.listSuppressions() });
    }),
  );
  r.delete(
    '/email/suppressions/:id',
    requirePermission('settings.manage'),
    validate({ params: z.object({ id: id24 }) }),
    asyncHandler(async (req, res) => {
      if (!(await emailEvents.removeSuppression(String(req.params.id)))) throw notFound();
      const a = actorOf(req);
      await audit(req, { action: 'email.suppression_removed', actorId: a.userId, actorRoles: a.roles, subjectType: 'suppression', subjectId: String(req.params.id) });
      res.json({ removed: true });
    }),
  );

  r.get(
    '/whatsapp/templates',
    requirePermission('settings.manage'),
    asyncHandler(async (_req, res) => {
      await whatsapp.ensureDefaultTemplates();
      res.json({ items: await whatsapp.listTemplates() });
    }),
  );
  r.put(
    '/whatsapp/templates',
    requirePermission('settings.manage'),
    validate({ body: templateSchema }),
    asyncHandler(async (req, res) => {
      const a = actorOf(req);
      await WhatsAppTemplate.updateOne({ name: req.body.name, language: req.body.language }, { $set: req.body }, { upsert: true });
      await audit(req, { action: 'whatsapp.template_saved', actorId: a.userId, actorRoles: a.roles, subjectType: 'whatsapp_template', subjectId: req.body.name, after: { approvalStatus: req.body.approvalStatus } });
      res.json({ items: await whatsapp.listTemplates() });
    }),
  );
  return r;
}
