import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { Consent } from '../models/auth';
import { User } from '../models/core';
import { WhatsAppOptIn, WhatsAppTemplate } from '../models/messaging';
import { Delivery } from '../models/notifications';

export const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPT OUT', 'OPTOUT']);

export function verifyMetaSignature(appSecret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The challenge Meta sends once when the webhook URL is registered. */
export function verifyChallenge(ctx: AppContext, q: Record<string, unknown>): string {
  if (q['hub.mode'] === 'subscribe' && ctx.env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === ctx.env.WHATSAPP_VERIFY_TOKEN) {
    return String(q['hub.challenge'] ?? '');
  }
  throw badRequest('Verification failed');
}

interface MetaPayload {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id: string; status: string; recipient_id?: string; errors?: { title?: string }[] }[];
        messages?: { from: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
}

/** Records the member's opt-out everywhere it matters: the consent log, the opt-in history and the channel itself. */
export async function optOut(ctx: AppContext, e164: string, source: 'keyword' | 'settings' | 'staff') {
  const phoneHash = ctx.crypto.blindIndex(e164);
  const users = await User.find({ phoneHash }).select('_id').lean();
  for (const u of users) {
    await Consent.create({ userId: u._id, purpose: 'whatsapp', granted: false });
    await WhatsAppOptIn.create({ userId: u._id, phoneHash, status: 'opted_out', source });
  }
  return users.length;
}

export async function recordOptIn(ctx: AppContext, userId: string, e164: string, source: 'settings' | 'staff' = 'settings') {
  await WhatsAppOptIn.create({ userId, phoneHash: ctx.crypto.blindIndex(e164), status: 'opted_in', source });
}

/** Applies delivery receipts and handles STOP replies. Safe to receive twice. */
export async function handleWebhook(ctx: AppContext, payload: MetaPayload) {
  let statuses = 0;
  let optOuts = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        const map: Record<string, 'delivered' | 'failed' | undefined> = { delivered: 'delivered', read: 'delivered', failed: 'failed' };
        const next = map[s.status];
        if (!next) continue;
        // A receipt can only move a message forward from "sent".
        const r = await Delivery.updateOne(
          { providerId: s.id, status: { $in: ['sent', 'queued'] } },
          { $set: { status: next, ...(next === 'delivered' ? { deliveredAt: new Date() } : { error: s.errors?.[0]?.title?.slice(0, 200) }) } },
        );
        statuses += r.modifiedCount;
      }
      for (const m of change.value?.messages ?? []) {
        const body = m.text?.body?.trim().toUpperCase();
        if (body && OPT_OUT_WORDS.has(body)) optOuts += await optOut(ctx, `+${m.from.replace(/^\+/, '')}`, 'keyword');
      }
    }
  }
  return { statuses, optOuts };
}

// ---------------------------------------------------------------- template registry

/** Seed templates every deployment needs. Names must match what is approved in the Meta dashboard. */
export const DEFAULT_TEMPLATES = [
  { name: 'mm_notification', language: 'en', category: 'utility' as const, variables: 2, body: '{{1}}. {{2}}', purpose: 'Introduction, payment and verification updates' },
  { name: 'mm_otp', language: 'en', category: 'authentication' as const, variables: 1, body: '{{1}} is your Marchmaker code. It expires in 5 minutes. Do not share it.', purpose: 'One-time sign-in codes' },
];

export async function ensureDefaultTemplates() {
  for (const t of DEFAULT_TEMPLATES) {
    await WhatsAppTemplate.updateOne({ name: t.name, language: t.language }, { $setOnInsert: { ...t, approvalStatus: 'draft' } }, { upsert: true });
  }
}

/**
 * A template may be sent only once it is approved. In development, with no registry rows, sends are
 * allowed so the mock provider works out of the box; in production an unknown or unapproved template is refused.
 */
export async function templateReady(ctx: AppContext, name: string): Promise<boolean> {
  const row = await WhatsAppTemplate.findOne({ name }).select('approvalStatus').lean();
  if (row) return row.approvalStatus === 'approved';
  return ctx.env.NODE_ENV !== 'production';
}

export async function listTemplates() {
  const rows = await WhatsAppTemplate.find().sort({ name: 1 }).lean();
  return rows.map((t) => ({
    id: String(t._id),
    name: t.name,
    language: t.language,
    category: t.category,
    variables: t.variables,
    body: t.body ?? '',
    approvalStatus: t.approvalStatus,
    purpose: t.purpose ?? '',
  }));
}
