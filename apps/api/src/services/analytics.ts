import type { z } from 'zod';
import { sanitizeProps, type analyticsBatchSchema } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AnalyticsEvent } from '../models/growth';
import { currentConsents } from './legal';

const RETENTION_DAYS = 400;
const DAY = 86_400_000;

/**
 * Stores consent-gated product events. A signed-in member's stored consent is checked on the
 * server, so a stale browser setting cannot override a withdrawal. Anything not on the allow list
 * is dropped before it reaches the database.
 */
export async function ingest(ctx: AppContext, userId: string | null, body: z.infer<typeof analyticsBatchSchema>) {
  let uid: string | undefined;
  if (userId) {
    const consents = await currentConsents(userId);
    if (consents.analytics?.granted !== true) return { accepted: 0 };
    uid = ctx.crypto.blindIndex(`analytics:${userId}`);
  }
  const now = Date.now();
  const docs = body.events.map((e) => {
    // Clamp client clocks to a day either side of now.
    const at = e.at && Math.abs(e.at.getTime() - now) < DAY ? e.at : new Date(now);
    return {
      name: e.name,
      anonId: body.anonId,
      uid,
      props: sanitizeProps(e.props),
      at,
      expiresAt: new Date(now + RETENTION_DAYS * DAY),
    };
  });
  await AnalyticsEvent.insertMany(docs, { ordered: false });
  return { accepted: docs.length };
}

export async function eventSummary(from: Date, to: Date) {
  const [byName, topPaths, exposures] = await Promise.all([
    AnalyticsEvent.aggregate<{ _id: string; n: number; visitors: string[] }>([
      { $match: { at: { $gte: from, $lte: to } } },
      { $group: { _id: '$name', n: { $sum: 1 }, visitors: { $addToSet: '$anonId' } } },
    ]),
    AnalyticsEvent.aggregate<{ _id: string; n: number }>([
      { $match: { name: 'page_view', at: { $gte: from, $lte: to }, 'props.path': { $exists: true } } },
      { $group: { _id: '$props.path', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 15 },
    ]),
    AnalyticsEvent.aggregate<{ _id: { e: string; v: string }; visitors: string[] }>([
      { $match: { name: 'experiment_exposed', at: { $gte: from, $lte: to } } },
      { $group: { _id: { e: '$props.experiment', v: '$props.variant' }, visitors: { $addToSet: '$anonId' } } },
    ]),
  ]);
  return {
    byName: byName.map((r) => ({ name: r._id, events: r.n, visitors: r.visitors.length })).sort((a, b) => b.events - a.events),
    topPaths: topPaths.map((r) => ({ path: r._id, views: r.n })),
    exposures: exposures.map((r) => ({ experiment: r._id.e, variant: r._id.v, visitors: r.visitors.length })),
  };
}
