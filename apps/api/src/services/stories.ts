import type { Request } from 'express';
import type { Role } from '@marchmaker/shared';
import { audit, emit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { SuccessStory } from '../models/content';

interface Actor {
  userId: string;
  roles: Role[];
}
const sid = (v: unknown) => String(v);

const present = (s: {
  _id: unknown;
  coupleNames: string;
  city?: string | null;
  quote: string;
  status: string;
  submittedAt?: Date | null;
  decisionNote?: string | null;
}) => ({
  id: sid(s._id),
  coupleNames: s.coupleNames,
  city: s.city ?? null,
  quote: s.quote,
  status: s.status,
  submittedAt: s.submittedAt ?? null,
  // Staff notes are written for the couple, so they can be shown to them.
  note: s.decisionNote ?? null,
});

export async function submit(userId: string, input: { coupleNames: string; city?: string; quote: string }) {
  const open = await SuccessStory.exists({ submittedBy: userId, status: { $in: ['submitted', 'published'] } });
  if (open) throw conflict('You have already shared a story. You can withdraw it first if you want to change it.');
  const s = await SuccessStory.create({
    coupleNames: input.coupleNames,
    city: input.city,
    quote: input.quote,
    originalQuote: input.quote,
    submittedBy: userId,
    submittedAt: new Date(),
    status: 'submitted',
    published: false,
  });
  return present(s);
}

export async function mine(userId: string) {
  const rows = await SuccessStory.find({ submittedBy: userId, status: { $ne: 'withdrawn' } }).sort({ createdAt: -1 }).limit(5).lean();
  return { items: rows.map(present) };
}

/** Withdrawing takes a story off the public site at once and keeps nothing public. */
export async function withdraw(userId: string, id: string) {
  const r = await SuccessStory.updateOne(
    { _id: id, submittedBy: userId, status: { $ne: 'withdrawn' } },
    { $set: { status: 'withdrawn', published: false }, $unset: { consentGivenAt: 1 } },
  );
  if (!r.matchedCount) throw notFound();
  return { withdrawn: true };
}

export async function adminList(status?: string) {
  const q: Record<string, unknown> =
    status && status !== 'all' ? { status, submittedBy: { $exists: true } } : { status: 'submitted', submittedBy: { $exists: true } };
  const rows = await SuccessStory.find(q).sort({ submittedAt: 1 }).limit(100).lean();
  return {
    items: rows.map((s) => ({ ...present(s), submittedBy: s.submittedBy ? sid(s.submittedBy) : null, originalQuote: s.originalQuote ?? null })),
  };
}

export async function decide(
  req: Request,
  id: string,
  input: { decision: 'publish' | 'reject'; coupleNames?: string; quote?: string; partnerConsentConfirmed?: boolean; note: string },
  actor: Actor,
) {
  const s = await SuccessStory.findById(id);
  if (!s || !s.submittedBy) throw notFound();
  if (s.status !== 'submitted') throw conflict('This story has already been decided');
  if (input.decision === 'publish') {
    if (!input.partnerConsentConfirmed) throw conflict('Confirm that the partner has also agreed before publishing');
    if (input.coupleNames) s.coupleNames = input.coupleNames;
    if (input.quote) s.quote = input.quote;
    s.status = 'published';
    s.published = true;
    s.consentGivenAt = new Date();
    s.consentRecordedBy = actor.userId as never;
    s.partnerConsentConfirmedAt = new Date();
  } else {
    s.status = 'rejected';
    s.published = false;
  }
  s.decisionNote = input.note;
  await s.save();
  await audit(req, {
    action: `story.${input.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'story',
    subjectId: id,
    after: { note: input.note, edited: input.decision === 'publish' && s.quote !== s.originalQuote },
  });
  await emit('story.decided', { userId: sid(s.submittedBy), storyId: id });
  return present(s);
}
