import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../context';
import { Delivery } from '../models/notifications';
import { EmailEvent, EmailSuppression } from '../models/messaging';

const FIVE_MIN = 5 * 60_000;
const RETENTION_MS = 400 * 86_400_000;

/**
 * Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>" using the base64 part of
 * the "whsec_..." secret, sent as "v1,<base64>" (possibly several, space separated). Old timestamps
 * are refused so a captured request cannot be replayed later.
 */
export function verifySvix(secret: string, headers: Record<string, string | undefined>, raw: Buffer, now = Date.now()): boolean {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigs = headers['svix-signature'];
  if (!id || !ts || !sigs) return false;
  if (Math.abs(now / 1000 - Number(ts)) > FIVE_MIN / 1000) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest();
  return sigs.split(' ').some((s) => {
    const [v, sig] = s.split(',');
    if (v !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; message?: string }; reason?: string };
}

/**
 * Stores the event once, updates the matching notification delivery, and suppresses addresses that
 * bounced for good or complained. Repeats and out-of-order events change nothing twice.
 */
export async function handleResendEvent(ctx: AppContext, eventId: string, ev: ResendEvent): Promise<'stored' | 'duplicate'> {
  const to = Array.isArray(ev.data?.to) ? ev.data?.to[0] : ev.data?.to;
  const toHash = to ? ctx.crypto.blindIndex(to) : undefined;
  const at = ev.created_at ? new Date(ev.created_at) : new Date();
  try {
    await EmailEvent.create({
      providerEventId: eventId,
      providerMessageId: ev.data?.email_id,
      type: ev.type,
      toHash,
      reason: ev.data?.bounce?.message ?? ev.data?.reason,
      at,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return 'duplicate';
    throw err;
  }

  const id = ev.data?.email_id;
  if (ev.type === 'email.delivered' && id) {
    await Delivery.updateOne({ providerId: id, status: { $in: ['sent', 'queued'] } }, { $set: { status: 'delivered', deliveredAt: at } });
  } else if (ev.type === 'email.bounced') {
    // "Permanent" means the address will never work; transient bounces are not suppressed.
    const permanent = (ev.data?.bounce?.type ?? 'Permanent').toLowerCase() === 'permanent';
    if (id) await Delivery.updateOne({ providerId: id }, { $set: { status: 'bounced', error: ev.data?.bounce?.message?.slice(0, 200) } });
    if (permanent && toHash) {
      await EmailSuppression.updateOne({ toHash }, { $setOnInsert: { kind: 'hard_bounce', reason: ev.data?.bounce?.message?.slice(0, 200), source: 'provider' } }, { upsert: true });
    }
  } else if (ev.type === 'email.complained') {
    if (id) await Delivery.updateOne({ providerId: id }, { $set: { status: 'complained' } });
    if (toHash) await EmailSuppression.updateOne({ toHash }, { $setOnInsert: { kind: 'complaint', source: 'provider' } }, { upsert: true });
  }
  return 'stored';
}

export async function listSuppressions(limit = 100) {
  const rows = await EmailSuppression.find().sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({ id: String(r._id), kind: r.kind, reason: r.reason ?? null, source: r.source, at: r.createdAt }));
}

export async function removeSuppression(id: string) {
  return (await EmailSuppression.deleteOne({ _id: id })).deletedCount === 1;
}
