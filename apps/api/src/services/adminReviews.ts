import { z } from 'zod';
import type { Request } from 'express';
import { DEFAULTS, PROFILE_STEPS, journeyMachine, type JourneyState } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit, logTransition } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Photo, Profile } from '../models/profile';

interface Actor {
  userId: string;
  roles: string[];
}

// ------------------------------------------------------------ profile review

export const profileDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({
    decision: z.literal('request_changes'),
    message: z.string().trim().min(10, 'Tell the member what to change').max(1000),
    stepKeys: z.array(z.enum(PROFILE_STEPS)).max(8).default([]),
  }),
  z.object({
    decision: z.literal('reopen'),
    message: z.string().trim().min(10, 'Tell the member why').max(1000),
    stepKeys: z.array(z.enum(PROFILE_STEPS)).max(8).default([]),
  }),
]);
export type ProfileDecision = z.infer<typeof profileDecisionSchema>;

export async function profileQueue(status: 'submitted' | 'changes_requested' | 'approved' = 'submitted', limit = 50) {
  const rows = await Profile.find({ status })
    .sort({ submittedAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } })
    .select('firstName gender plan')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const now = Date.now();
  return rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, Record<string, unknown>>;
    const u = byId.get(String(r.userId));
    return {
      userId: String(r.userId),
      firstName: u?.firstName ?? '',
      gender: u?.gender ?? null,
      city: (data.background?.city as string | undefined) ?? null,
      plan: u?.plan?.planCode ?? 'free',
      submittedAt: r.submittedAt ?? null,
      waitingHours: r.submittedAt ? Math.round((now - r.submittedAt.getTime()) / 3_600_000) : null,
      status: r.status,
    };
  });
}

async function moveJourney(userId: string, to: JourneyState, actorId: string, reason: string) {
  const user = await User.findById(userId).select('journeyState');
  if (!user) throw notFound('Member not found');
  const from = user.journeyState as JourneyState;
  if (from === to) return;
  if (!journeyMachine.canTransition(from, to)) throw conflict(`Cannot move this member from ${from} to ${to}`);
  await User.updateOne({ _id: userId, journeyState: from }, { $set: { journeyState: to } });
  await logTransition('user_journey', userId, from, to, actorId, reason);
}

export async function decideProfile(req: Request, userId: string, actor: Actor, d: ProfileDecision) {
  const profile = await Profile.findOne({ userId });
  if (!profile) throw notFound('Profile not found');
  const now = new Date();

  if (d.decision === 'approve') {
    if (profile.status !== 'submitted') throw conflict('Only a submitted profile can be approved');
    const claimed = await Profile.findOneAndUpdate(
      { _id: profile._id, status: 'submitted' },
      { $set: { status: 'approved', approvedAt: now }, $inc: { version: 1 } },
    );
    if (!claimed) throw conflict('This profile was already decided');
    await moveJourney(userId, 'profile_approved', actor.userId, 'profile approved');
    await emit('profile.approved', { userId });
  } else if (d.decision === 'request_changes') {
    if (profile.status !== 'submitted') throw conflict('Changes can only be requested on a submitted profile');
    const claimed = await Profile.findOneAndUpdate(
      { _id: profile._id, status: 'submitted' },
      {
        $set: { status: 'changes_requested' },
        $inc: { version: 1 },
        $push: { reviewNotes: { at: now, by: actor.userId, message: d.message, stepKeys: d.stepKeys } },
      },
    );
    if (!claimed) throw conflict('This profile was already decided');
    await moveJourney(userId, 'profile_changes_requested', actor.userId, 'changes requested');
    await emit('profile.changes_requested', { userId });
  } else {
    if (profile.status !== 'approved') throw conflict('Only an approved profile can be reopened');
    const claimed = await Profile.findOneAndUpdate(
      { _id: profile._id, status: 'approved' },
      {
        $set: { status: 'changes_requested' },
        $inc: { version: 1 },
        $push: { reviewNotes: { at: now, by: actor.userId, message: d.message, stepKeys: d.stepKeys } },
      },
    );
    if (!claimed) throw conflict('This profile was already decided');
    await moveJourney(userId, 'profile_changes_requested', actor.userId, 'profile reopened');
    await emit('profile.changes_requested', { userId });
  }

  await audit(req, {
    action: `profile.${d.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: userId,
    after: d.decision === 'approve' ? {} : { message: d.message, stepKeys: d.stepKeys },
  });
  return { userId, decision: d.decision };
}

// ------------------------------------------------------------ photo review

export const PHOTO_REJECTION_REASONS = [
  'not_you',
  'group_photo',
  'inappropriate',
  'low_quality',
  'contains_contact_info',
  'other',
] as const;

export const photoDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('reject'), reason: z.enum(PHOTO_REJECTION_REASONS) }),
]);
export type PhotoDecision = z.infer<typeof photoDecisionSchema>;

export async function photoQueue(ctx: AppContext, status: 'pending' | 'approved' | 'rejected' = 'pending', limit = 50) {
  const rows = await Photo.find({ status }).sort({ createdAt: 1 }).limit(limit).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } })
    .select('firstName')
    .lean();
  const name = new Map(users.map((u) => [String(u._id), u.firstName]));
  return Promise.all(
    rows.map(async (p) => ({
      id: String(p._id),
      userId: String(p.userId),
      firstName: name.get(String(p.userId)) ?? '',
      isPrimary: p.isPrimary,
      status: p.status,
      uploadedAt: p.createdAt,
      moderation: p.moderation ?? null,
      /** Shown to the reviewer as a prompt to look closely; it never rejects a photo by itself. */
      flags: [...(p.moderation?.faceDetected === false ? ['no_face'] : []), ...(p.moderation?.faceDetected == null ? ['not_checked'] : [])],
      url: p.variants?.md ? await ctx.storage.presignGet('photos', p.variants.md, DEFAULTS.signedUrlTtlSec) : null,
    })),
  );
}

export async function decidePhoto(req: Request, id: string, actor: Actor, d: PhotoDecision) {
  const photo = await Photo.findById(id);
  if (!photo) throw notFound('Photo not found');
  if (photo.status !== 'pending') throw conflict('This photo has already been reviewed');
  const set =
    d.decision === 'approve'
      ? { status: 'approved' as const }
      : { status: 'rejected' as const, rejectionReason: d.reason };
  const claimed = await Photo.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { ...set, reviewedBy: actor.userId, reviewedAt: new Date() } },
  );
  if (!claimed) throw conflict('This photo has already been reviewed');

  if (d.decision === 'reject' && photo.isPrimary) {
    // A rejected photo cannot stay the main one: hand the role to the next usable photo.
    await Photo.updateOne({ _id: id }, { $set: { isPrimary: false } });
    const next = await Photo.findOne({ userId: photo.userId, status: { $in: ['pending', 'approved'] }, _id: { $ne: id } }).sort({ order: 1 });
    if (next) await Photo.updateOne({ _id: next._id }, { $set: { isPrimary: true } });
  }
  await audit(req, {
    action: `photo.${d.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'photo',
    subjectId: id,
    after: { memberId: String(photo.userId), ...(d.decision === 'reject' && { reason: d.reason }) },
  });
  await emit(`photo.${d.decision === 'approve' ? 'approved' : 'rejected'}`, { userId: String(photo.userId), photoId: id });
  return { id, decision: d.decision };
}
