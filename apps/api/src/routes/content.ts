import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { DEFAULT_PACKS, DEFAULT_PLANS, emailSchema } from '@marchmaker/shared';
import { z } from 'zod';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { validate } from '../middleware/validate';
import { FeatureFlag } from '../models/core';
import { ContactMessage, Guide, Plan, SuccessStory } from '../models/content';
import { sendNotice } from '../services/notify';
import * as support from '../services/support';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  topic: z.enum(['general', 'support', 'press', 'partnership', 'grievance']).default('general'),
  message: z.string().trim().min(10, 'Please tell us a little more').max(4000),
  /** Honeypot: real people never fill this in. */
  website: z.string().max(200).optional(),
});

export function contentRouter(ctx: AppContext): Router {
  const r = Router();

  // Plans come from the database; if it has none yet (fresh install) the seed defaults are served.
  r.get(
    '/plans',
    asyncHandler(async (_req, res) => {
      const rows = await Plan.find({ active: true }).sort({ sortOrder: 1 }).lean();
      const fromDb = rows.map((p) => ({
        code: p.code,
        kind: p.kind,
        name: p.name,
        tagline: p.tagline ?? '',
        prices: p.prices,
        credits: p.credits,
        fairUseCap: p.fairUseCap ?? undefined,
        features: p.features,
        highlight: p.highlight,
        sortOrder: p.sortOrder,
      }));
      const items = fromDb.length ? fromDb : [...DEFAULT_PLANS, ...DEFAULT_PACKS];
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ items, currency: 'INR', pricesIncludeGst: true });
    }),
  );

  // Public, non-sensitive feature switches so the UI can hide unavailable options.
  r.get(
    '/flags',
    asyncHandler(async (_req, res) => {
      const rows = await FeatureFlag.find().lean();
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ flags: Object.fromEntries(rows.map((f) => [f.key, f.enabled])) });
    }),
  );

  r.get(
    '/success-stories',
    asyncHandler(async (_req, res) => {
      const rows = await SuccessStory.find({ published: true, consentGivenAt: { $exists: true, $ne: null } })
        .sort({ sortOrder: 1, marriedOn: -1 })
        .limit(12)
        .select('coupleNames city quote marriedOn')
        .lean();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        items: rows.map((s) => ({
          id: String(s._id),
          coupleNames: s.coupleNames,
          city: s.city ?? null,
          quote: s.quote,
          marriedOn: s.marriedOn ?? null,
        })),
      });
    }),
  );

  // Public index only: bodies and audio are served to entitled members in Phase 15.
  r.get(
    '/guides',
    asyncHandler(async (_req, res) => {
      const rows = await Guide.find({ published: true })
        .sort({ publishedAt: -1 })
        .limit(50)
        .select('slug title summary category audioSeconds access publishedAt')
        .lean();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({
        items: rows.map((g) => ({
          slug: g.slug,
          title: g.title,
          summary: g.summary ?? '',
          category: g.category ?? null,
          hasAudio: !!g.audioSeconds,
          audioSeconds: g.audioSeconds ?? null,
          access: g.access,
          publishedAt: g.publishedAt ?? null,
        })),
      });
    }),
  );

  const contactLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: ctx.env.NODE_ENV === 'test' ? 1000 : 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many messages. Please try again later.', requestId: req.id },
      });
    },
  });

  r.post(
    '/contact',
    contactLimiter,
    validate({ body: contactSchema }),
    asyncHandler(async (req, res) => {
      const { website, ...input } = req.body as z.infer<typeof contactSchema>;
      if (website) {
        // A bot: answer exactly like a real submission, store nothing.
        res.status(202).json({ received: true });
        return;
      }
      await ContactMessage.create({ ...input, ip: req.ip });
      // Help and grievance requests become tickets so they have an owner and a response clock.
      if (['general', 'support', 'grievance'].includes(input.topic)) {
        await support.create(ctx, {
          email: input.email,
          name: input.name,
          category: 'other',
          subject: `${input.topic === 'grievance' ? 'Grievance' : 'Contact form'}: ${input.message.slice(0, 60)}`,
          body: input.message,
          priority: input.topic === 'grievance' ? 'high' : 'normal',
        });
      }
      await sendNotice(ctx, ctx.env.SUPPORT_EMAIL, {
        subject: `[Contact:${input.topic}] from ${input.name}`,
        preview: input.message.slice(0, 80),
        heading: `New ${input.topic} message`,
        paragraphs: [`From: ${input.name} <${input.email}>`, input.message],
      });
      res.status(202).json({ received: true });
    }),
  );

  return r;
}
