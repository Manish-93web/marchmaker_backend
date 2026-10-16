import { renderNotice } from '@marchmaker/email';
import type { AppContext } from '../context';
import { Setting, User } from '../models/core';
import { MatchSuggestion } from '../models/matching';
import { Report } from '../models/social';
import { Ticket } from '../models/safety';
import { getReviewSettings } from './settings';

const DIGEST_EVERY_MS = 6 * 3_600_000;

async function mail(ctx: AppContext, to: string, subject: string, lines: string[], url: string) {
  const m = await renderNotice({ subject, preview: lines[0] ?? subject, heading: subject, paragraphs: lines, cta: { label: 'Open the console', url } });
  await ctx.mailer.send({ to, ...m });
}

/**
 * Pushes deadline breaches to people instead of waiting for someone to look at a dashboard:
 *  - a high or critical report past its deadline pages on-call (email, and WhatsApp when configured), once;
 *  - tickets past their first-response target go to the support inbox, once each, as one message;
 *  - review queues older than the review SLA are summarised to on-call at most every six hours.
 * Each item carries a marker, so running the sweep again never repeats an alert.
 */
export async function sendSlaAlerts(ctx: AppContext, now = new Date()) {
  const oncall = ctx.env.ONCALL_EMAIL ?? ctx.env.SUPPORT_EMAIL;
  const out = { reports: 0, tickets: 0, digest: false };

  const reports = await Report.find({
    status: { $in: ['open', 'investigating'] },
    severity: { $in: ['high', 'critical'] },
    slaDueAt: { $lt: now },
    slaAlertedAt: { $exists: false },
  }).limit(50);
  for (const r of reports) {
    const claimed = await Report.updateOne({ _id: r._id, slaAlertedAt: { $exists: false } }, { $set: { slaAlertedAt: now } });
    if (!claimed.modifiedCount) continue;
    await mail(ctx, oncall, `A ${r.severity} report is overdue`, [`A ${r.severity} report (${r.category.replaceAll('_', ' ')}) has passed its response deadline and is still ${r.status}.`], `${ctx.env.ADMIN_URL}/moderation/${r._id}`);
    for (const to of ctx.env.ONCALL_WHATSAPP?.split(',').map((s) => s.trim()).filter(Boolean) ?? []) {
      await ctx.whatsapp?.sendTemplate(to, 'mm_oncall_alert', [`A ${r.severity} safety report is overdue`, String(r._id).slice(-6)]).catch((err) => ctx.log.warn({ err }, 'oncall whatsapp failed'));
    }
    out.reports++;
  }

  const tickets = await Ticket.find({ status: 'open', firstResponseAt: { $exists: false }, firstResponseDueAt: { $lt: now }, slaAlertedAt: { $exists: false } }).limit(100);
  const fresh: string[] = [];
  for (const t of tickets) {
    const claimed = await Ticket.updateOne({ _id: t._id, slaAlertedAt: { $exists: false } }, { $set: { slaAlertedAt: now } });
    if (claimed.modifiedCount) fresh.push(`${t.number}: ${t.subject}`);
  }
  if (fresh.length) {
    await mail(ctx, ctx.env.SUPPORT_EMAIL, `${fresh.length} support ticket${fresh.length > 1 ? 's' : ''} past the first-response target`, fresh.slice(0, 20), `${ctx.env.ADMIN_URL}/support`);
    out.tickets = fresh.length;
  }

  const last = (await Setting.findOne({ key: 'sla_digest' }).lean())?.value as { at?: string } | undefined;
  if (!last?.at || now.getTime() - new Date(last.at).getTime() >= DIGEST_EVERY_MS) {
    const hours = (await getReviewSettings()).reviewSlaHours;
    const cutoff = new Date(now.getTime() - hours * 3_600_000);
    const [profiles, suggestions] = await Promise.all([
      User.countDocuments({ journeyState: 'profile_submitted', status: 'active', updatedAt: { $lt: cutoff } }),
      MatchSuggestion.countDocuments({ status: { $in: ['suggested', 'in_review'] }, createdAt: { $lt: cutoff } }),
    ]);
    const verifications = await User.countDocuments({ journeyState: 'verification_pending', status: 'active', updatedAt: { $lt: cutoff } });
    if (profiles + suggestions + verifications > 0) {
      await mail(
        ctx,
        oncall,
        'Review queues are behind',
        [`Items waiting longer than ${hours} hours: ${profiles} profile reviews, ${verifications} verifications, ${suggestions} match suggestions.`],
        ctx.env.ADMIN_URL,
      );
      out.digest = true;
    }
    await Setting.updateOne({ key: 'sla_digest' }, { $set: { value: { at: now.toISOString() } } }, { upsert: true });
  }
  return out;
}
