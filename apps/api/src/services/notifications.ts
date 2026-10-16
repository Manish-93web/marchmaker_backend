import { createHmac, timingSafeEqual } from 'node:crypto';
import { renderEventEmail, renderNotice } from '@marchmaker/email';
import {
  NOTIFICATION_SPECS,
  decideChannels,
  notificationCategories,
  resolvePrefs,
  type NotificationChannel,
  type NotificationSpec,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { badRequest, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Introduction } from '../models/matching';
import { Delivery, Notification, PushSubscription } from '../models/notifications';
import { currentConsents } from './legal';
import { templateReady } from './whatsapp';

const MAX_ATTEMPTS = 4;
const isDup = (e: unknown) => (e as { code?: number }).code === 11000;
const sid = (v: unknown) => String(v);

// ------------------------------------------------------------------ unsubscribe links

const sign = (ctx: AppContext, data: string) =>
  createHmac('sha256', ctx.env.JWT_REFRESH_SECRET).update(`unsub:${data}`).digest('base64url');

export function unsubscribeToken(ctx: AppContext, userId: string, category: string): string {
  const data = Buffer.from(`${userId}.${category}`).toString('base64url');
  return `${data}.${sign(ctx, data)}`;
}

function parseUnsubscribeToken(ctx: AppContext, token: string): { userId: string; category: string } | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = sign(ctx, data);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [userId, category] = Buffer.from(data, 'base64url').toString().split('.');
  if (!userId || !category || !(notificationCategories as readonly string[]).includes(category)) return null;
  return { userId, category };
}

export async function unsubscribe(ctx: AppContext, token: string) {
  const t = parseUnsubscribeToken(ctx, token);
  if (!t) throw badRequest('That link is not valid or has expired');
  await User.updateOne({ _id: t.userId }, { $set: { [`notificationPrefs.channels.${t.category}.email`]: false } });
  return { category: t.category };
}

// ------------------------------------------------------------------ dispatch

async function recipientsFor(eventType: string, p: Record<string, unknown>): Promise<string[]> {
  if (eventType === 'introduction.contact_shared') {
    const i = await Introduction.findById(String(p.introductionId)).select('members.userId').lean();
    return (i?.members ?? []).map((m) => sid(m.userId));
  }
  return typeof p.userId === 'string' ? [p.userId] : [];
}

/** Turns one domain event into notifications for the people it concerns. Safe to run twice for the same event. */
export async function dispatchEvent(ctx: AppContext, eventType: string, payload: Record<string, unknown>, eventId: string) {
  if (eventType === 'safety.critical_report') {
    const to = ctx.env.ONCALL_EMAIL ?? ctx.env.SUPPORT_EMAIL;
    try {
      const mail = await renderNotice({
        subject: 'Critical safety report needs attention',
        preview: 'A critical report was filed',
        heading: 'Critical safety report',
        paragraphs: [`A report in the category "${String(payload.category)}" was filed. Please review it in the console now.`],
        cta: { label: 'Open moderation', url: `${ctx.env.ADMIN_URL}/` },
      });
      await ctx.mailer.send({ to, ...mail });
    } catch (err) {
      ctx.log.error({ err }, 'on-call alert failed');
      throw err;
    }
    // A second channel for critical safety reports: a missed email must not delay a response.
    for (const number of ctx.env.ONCALL_WHATSAPP?.split(',').map((s) => s.trim()).filter(Boolean) ?? []) {
      if (!ctx.whatsapp || !(await templateReady(ctx, 'mm_oncall_alert'))) break;
      await ctx.whatsapp.sendTemplate(number, 'mm_oncall_alert', ['A critical safety report was filed', String(payload.reportId ?? '').slice(-6)]).catch((err) => ctx.log.warn({ err }, 'on-call whatsapp failed'));
    }
    return 1;
  }
  const spec = NOTIFICATION_SPECS[eventType];
  if (!spec) return 0;
  if (eventType === 'legal.updated') {
    // One event for everyone: fan out in pages. Each member's notification is keyed by document and version, so a retry never repeats.
    let n = 0;
    let after: unknown;
    for (;;) {
      const page = await User.find({ roles: 'member', status: 'active', ...(after ? { _id: { $gt: after } } : {}) }).sort({ _id: 1 }).limit(500).select('_id').lean();
      if (!page.length) break;
      for (const u of page) if (await notifyUser(ctx, sid(u._id), eventType, spec, { ...payload, userId: sid(u._id) }, eventId)) n++;
      after = page[page.length - 1]!._id;
    }
    return n;
  }
  let n = 0;
  for (const userId of await recipientsFor(eventType, payload)) {
    if (await notifyUser(ctx, userId, eventType, spec, { ...payload, userId }, eventId)) n++;
  }
  return n;
}

async function notifyUser(
  ctx: AppContext,
  userId: string,
  type: string,
  spec: NotificationSpec,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<boolean> {
  const user = await User.findById(userId).select('email phoneEnc phoneVerifiedAt notificationPrefs plan status').lean();
  if (!user || ['deleted', 'banned'].includes(user.status)) return false;

  const copy = spec.copy(payload);
  const group = spec.groupBy?.(payload);
  if (group) {
    // A conversation with an unread notification just counts up; nobody is pinged again.
    const merged = await Notification.findOneAndUpdate(
      { userId, groupKey: group, readAt: { $exists: false } },
      { $inc: { count: 1 }, $set: { updatedAt: new Date() } },
    );
    if (merged) return false;
  }

  let notification;
  try {
    notification = await Notification.create({
      userId,
      type,
      category: spec.category,
      title: copy.title,
      body: copy.body,
      url: copy.url,
      sourceId: spec.sourceId(payload) ?? eventId,
      groupKey: group,
    });
  } catch (err) {
    if (isDup(err)) return false;
    throw err;
  }

  const [consents, pushCount] = await Promise.all([currentConsents(userId), PushSubscription.countDocuments({ userId })]);
  const decision = decideChannels({
    spec,
    prefs: resolvePrefs(user.notificationPrefs),
    consents: { whatsapp: consents.whatsapp?.granted, marketing_email: consents.marketing_email?.granted },
    planCode: user.plan?.planCode ?? 'free',
    hasEmail: Boolean(user.email),
    hasVerifiedPhone: Boolean(user.phoneEnc && user.phoneVerifiedAt),
    hasPush: pushCount > 0 && Boolean(ctx.push),
    now: new Date(),
  });

  const rows: Record<string, unknown>[] = [];
  for (const c of decision.send) {
    rows.push({
      notificationId: notification._id,
      userId,
      channel: c,
      status: c === 'in_app' ? 'sent' : 'queued',
      sentAt: c === 'in_app' ? new Date() : undefined,
      sendAfter: c !== 'in_app' && decision.deferUntil ? decision.deferUntil : new Date(),
    });
  }
  for (const [c, reason] of Object.entries(decision.skipped)) {
    rows.push({ notificationId: notification._id, userId, channel: c, status: 'skipped', reason });
  }
  if (rows.length) await Delivery.insertMany(rows, { ordered: false }).catch((e) => { if (!isDup(e) && e?.code !== 11000) throw e; });

  await sendDueDeliveries(ctx, new Date(), String(notification._id));
  return true;
}

// ------------------------------------------------------------------ delivery

async function deliverOne(ctx: AppContext, d: InstanceType<typeof Delivery>) {
  const n = await Notification.findById(d.notificationId).lean();
  const user = await User.findById(d.userId).select('email firstName phoneEnc').lean();
  if (!n || !user) return { ok: false as const, error: 'missing', final: true };
  const url = `${ctx.env.APP_URL}${n.url}`;
  const channel = d.channel as NotificationChannel;

  if (channel === 'email') {
    if (!user.email) return { ok: false as const, error: 'no_email', final: true };
    const critical = NOTIFICATION_SPECS[n.type]?.critical === true;
    const unsub = `${ctx.env.APP_URL}/unsubscribe?t=${unsubscribeToken(ctx, sid(d.userId), n.category)}`;
    const mail = await renderEventEmail(n.type, {
      title: n.title,
      body: n.body,
      url,
      detail: n.type === 'message.digest' ? `${n.body.match(/\d+/)?.[0] ?? ''} unread` : undefined,
      ...(critical ? {} : { unsubscribeUrl: unsub }),
    });
    const sent = await ctx.mailer.send({
      to: user.email,
      ...mail,
      ...(critical ? {} : { headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
    });
    if (sent?.suppressed) return { ok: false as const, error: 'suppressed', final: true };
    return { ok: true as const, providerId: sent?.id };
  }

  if (channel === 'whatsapp') {
    if (!ctx.whatsapp) return { ok: false as const, error: 'not_configured', final: true };
    if (!user.phoneEnc) return { ok: false as const, error: 'no_phone', final: true };
    if (!(await templateReady(ctx, 'mm_notification'))) return { ok: false as const, error: 'template_not_approved', final: true };
    const wa = await ctx.whatsapp.sendTemplate(ctx.crypto.decrypt(user.phoneEnc), 'mm_notification', [n.title, n.body]);
    return { ok: true as const, providerId: wa.id };
  }

  if (channel === 'push') {
    if (!ctx.push) return { ok: false as const, error: 'not_configured', final: true };
    const subs = await PushSubscription.find({ userId: d.userId });
    if (!subs.length) return { ok: false as const, error: 'no_device', final: true };
    let delivered = 0;
    for (const s of subs) {
      const r = await ctx.push.send({ endpoint: s.endpoint, keys: { p256dh: s.keys?.p256dh ?? '', auth: s.keys?.auth ?? '' } }, {
        title: n.title,
        body: n.body,
        url: n.url,
        tag: n.groupKey ?? sid(n._id),
      });
      if (r === 'gone') await PushSubscription.deleteOne({ _id: s._id });
      else delivered++;
    }
    return delivered ? { ok: true as const } : { ok: false as const, error: 'no_device', final: true };
  }
  return { ok: true as const };
}

/**
 * Sends queued deliveries that are due. A lease is taken first so two workers never send the
 * same one; failures back off and give up after four tries.
 */
export async function sendDueDeliveries(ctx: AppContext, now = new Date(), onlyNotificationId?: string): Promise<number> {
  let sent = 0;
  for (let i = 0; i < 200; i++) {
    const d = await Delivery.findOneAndUpdate(
      { status: 'queued', sendAfter: { $lte: now }, ...(onlyNotificationId && { notificationId: onlyNotificationId }) },
      { $inc: { attempts: 1 }, $set: { sendAfter: new Date(now.getTime() + 2 * 60_000) } },
      { returnDocument: 'after', sort: { sendAfter: 1 } },
    );
    if (!d) break;
    try {
      const r = await deliverOne(ctx, d);
      if (r.ok) {
        await Delivery.updateOne(
          { _id: d._id },
          { $set: { status: 'sent', sentAt: new Date(), ...('providerId' in r && r.providerId ? { providerId: r.providerId } : {}) }, $unset: { error: 1 } },
        );
        sent++;
      } else {
        await Delivery.updateOne({ _id: d._id }, { $set: { status: r.final ? 'skipped' : 'failed', reason: r.error } });
      }
    } catch (err) {
      const giveUp = d.attempts >= MAX_ATTEMPTS;
      ctx.log.warn({ err, channel: d.channel, attempts: d.attempts }, 'notification delivery failed');
      await Delivery.updateOne(
        { _id: d._id },
        {
          $set: {
            status: giveUp ? 'failed' : 'queued',
            error: String((err as Error).message).slice(0, 200),
            sendAfter: new Date(now.getTime() + 2 ** d.attempts * 60_000),
          },
        },
      );
    }
  }
  return sent;
}

// ------------------------------------------------------------------ member API

export async function list(userId: string, opts: { limit: number; before?: string; unreadOnly?: boolean }) {
  const filter: Record<string, unknown> = { userId };
  if (opts.unreadOnly) filter.readAt = { $exists: false };
  if (opts.before) filter._id = { $lt: opts.before };
  const rows = await Notification.find(filter).sort({ _id: -1 }).limit(opts.limit + 1).lean();
  const page = rows.slice(0, opts.limit);
  return {
    items: page.map(present),
    nextCursor: rows.length > opts.limit ? sid(page[page.length - 1]!._id) : null,
    unread: await unreadCount(userId),
  };
}

export const unreadCount = (userId: string) => Notification.countDocuments({ userId, readAt: { $exists: false } });

export function present(n: {
  _id: unknown;
  type: string;
  category: string;
  title: string;
  body: string;
  url: string;
  count?: number;
  readAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: sid(n._id),
    type: n.type,
    category: n.category,
    title: n.title,
    body: n.body,
    url: n.url,
    count: n.count ?? 1,
    read: Boolean(n.readAt),
    at: n.createdAt,
  };
}

export async function markRead(userId: string, id: string) {
  const r = await Notification.updateOne({ _id: id, userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  if (!r.matchedCount && !(await Notification.exists({ _id: id, userId }))) throw notFound();
  return { unread: await unreadCount(userId) };
}

export async function markAllRead(userId: string) {
  await Notification.updateMany({ userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  return { unread: 0 };
}

export async function preferences(ctx: AppContext, userId: string) {
  const user = await User.findById(userId).select('notificationPrefs plan phoneVerifiedAt').lean();
  if (!user) throw notFound();
  const [consents, devices] = await Promise.all([currentConsents(userId), PushSubscription.countDocuments({ userId })]);
  return {
    prefs: resolvePrefs(user.notificationPrefs),
    whatsapp: {
      consent: consents.whatsapp?.granted === true,
      phoneVerified: Boolean(user.phoneVerifiedAt),
      planAllows: ['premium', 'concierge'].includes(user.plan?.planCode ?? 'free'),
      available: Boolean(ctx.whatsapp),
    },
    push: { devices, available: Boolean(ctx.push), publicKey: ctx.push?.publicKey ?? null },
    marketingConsent: consents.marketing_email?.granted === true,
  };
}

export async function subscribePush(
  ctx: AppContext,
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
) {
  if (!ctx.push) throw badRequest('Browser notifications are not available right now');
  await PushSubscription.updateOne({ endpoint: sub.endpoint }, { $set: { userId, keys: sub.keys, userAgent: userAgent?.slice(0, 200) } }, { upsert: true });
  return { devices: await PushSubscription.countDocuments({ userId }) };
}

export async function unsubscribePush(userId: string, endpoint: string) {
  await PushSubscription.deleteOne({ userId, endpoint });
  return { devices: await PushSubscription.countDocuments({ userId }) };
}
