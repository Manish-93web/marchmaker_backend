import { Types } from 'mongoose';
import type { Request } from 'express';
import { ageOn, isStaff, journeyMachine, type JourneyState, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit, logTransition } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { AdminNote } from '../models/admin';
import { AssessmentResponse } from '../models/assessment';
import { User } from '../models/core';
import { Photo, Preference, Profile } from '../models/profile';
import { Verification } from '../models/verification';
import { DEFAULTS } from '@marchmaker/shared';
import { dimensionVectors } from './assessments';
import { buildMe } from './auth';
import { listOwnPhotos } from './photos';
import { getProfile } from './profile';
import { revokeAllSessions } from './sessions';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface MemberQuery {
  q?: string;
  status?: string;
  journeyState?: string;
  plan?: string;
  verified?: boolean;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

function maskPhone(phone: string | undefined): string | null {
  return phone ? `${phone.slice(0, 3)}${'•'.repeat(Math.max(0, phone.length - 5))}${phone.slice(-2)}` : null;
}

export async function searchMembers(ctx: AppContext, q: MemberQuery) {
  const filter: Record<string, unknown> = { roles: 'member' };
  const text = q.q?.trim();
  if (text) {
    if (/^[a-f\d]{24}$/i.test(text)) {
      filter._id = new Types.ObjectId(text);
    } else if (text.includes('@')) {
      filter.email = { $regex: `^${escapeRegex(text.toLowerCase())}` };
    } else if (/^(\+?91)?[6-9]\d{9}$/.test(text.replace(/[\s-]/g, ''))) {
      const digits = text.replace(/\D/g, '').slice(-10);
      filter.phoneHash = ctx.crypto.blindIndex(`+91${digits}`);
    } else {
      const rx = { $regex: `^${escapeRegex(text)}`, $options: 'i' };
      const byCity = await Profile.find({ 'data.background.city': rx }).select('userId').limit(500).lean();
      filter.$or = [{ firstName: rx }, ...(byCity.length ? [{ _id: { $in: byCity.map((p) => p.userId) } }] : [])];
    }
  }
  if (q.status) filter.status = q.status;
  if (q.journeyState) filter.journeyState = q.journeyState;
  if (q.plan) filter['plan.planCode'] = q.plan;
  if (q.verified === true) filter['verification.idVerifiedAt'] = { $exists: true };
  if (q.verified === false) filter['verification.idVerifiedAt'] = { $exists: false };
  if (q.from || q.to) {
    filter.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  }
  // Paging is by id (newest first). A direct id lookup returns exactly that member, so it ignores the cursor.
  if (!(filter._id instanceof Types.ObjectId) && q.cursor && /^[a-f\d]{24}$/i.test(q.cursor)) {
    filter._id = { $lt: new Types.ObjectId(q.cursor) };
  }

  const rows = await User.find(filter)
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((u) => ({
      id: String(u._id),
      firstName: u.firstName,
      email: u.email ?? null,
      gender: u.gender,
      status: u.status,
      journeyState: u.journeyState,
      plan: u.plan?.planCode ?? 'free',
      idVerified: !!u.verification?.idVerifiedAt,
      createdAt: u.createdAt,
      lastActiveAt: u.lastActiveAt ?? null,
    })),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!._id) : null,
  };
}

interface Viewer {
  userId: string;
  roles: Role[];
  permissions: readonly string[];
}

/** Detail for staff. Basic data for everyone with access; profile, preferences and assessments need `member.view_full`. */
export async function memberDetail(ctx: AppContext, req: Request, id: string, viewer: Viewer) {
  const user = await User.findById(id);
  if (!user) throw notFound('Member not found');
  const full = viewer.permissions.includes('member.view_full');
  const phone = user.phoneEnc ? ctx.crypto.decrypt(user.phoneEnc) : undefined;
  const dob = ctx.crypto.decrypt(user.dobEnc);

  const overview = {
    id,
    firstName: user.firstName,
    email: user.email ?? null,
    emailVerified: !!user.emailVerifiedAt,
    phone: maskPhone(phone),
    phoneVerified: !!user.phoneVerifiedAt,
    gender: user.gender,
    age: ageOn(new Date(dob)),
    roles: user.roles,
    status: user.status,
    journeyState: user.journeyState,
    plan: user.plan,
    creditBalance: user.creditBalance,
    walletBalancePaise: user.walletBalancePaise ?? 0,
    referralCode: user.referralCode ?? null,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt ?? null,
    verification: {
      id: !!user.verification?.idVerifiedAt,
      selfie: !!user.verification?.selfieVerifiedAt,
      liveness: !!user.verification?.livenessVerifiedAt,
    },
    moderation: user.moderation?.at
      ? { reason: user.moderation.reason, at: user.moderation.at, since: user.moderation.statusBefore }
      : null,
  };

  const out: Record<string, unknown> = { overview, canViewFull: full };

  const cases = await Verification.find({ userId: id }).sort({ createdAt: -1 }).limit(5).lean();
  out.verification = cases.map((c) => ({
    id: String(c._id),
    method: c.method,
    status: c.status,
    docType: c.docType ?? null,
    docLast4: c.docLast4 ?? null,
    submittedAt: c.submittedAt ?? null,
    decidedAt: c.decidedAt ?? null,
    evidencePurged: !!c.evidencePurgedAt,
  }));

  if (full) {
    const [profile, prefs, vectors, photos] = await Promise.all([
      getProfile(ctx, id),
      Preference.findOne({ userId: id }).lean(),
      dimensionVectors(id),
      Photo.find({ userId: id }).sort({ order: 1 }).lean(),
    ]);
    out.profile = profile;
    out.preferences = prefs?.dimensions ?? [];
    // Internal scores are shown to staff here and nowhere else.
    out.assessments = vectors;
    out.photos = await Promise.all(
      photos.map(async (p) => ({
        id: String(p._id),
        status: p.status,
        isPrimary: p.isPrimary,
        rejectionReason: p.rejectionReason ?? null,
        md: p.variants?.md ? await ctx.storage.presignGet('photos', p.variants.md, DEFAULTS.signedUrlTtlSec) : null,
      })),
    );
    await audit(req, {
      action: 'member.view_full',
      actorId: viewer.userId,
      actorRoles: viewer.roles,
      subjectType: 'user',
      subjectId: id,
    });
  }
  return out;
}

export type StatusAction = 'suspend' | 'ban' | 'pause' | 'restore';

/** Staff status changes. Every one needs a reason, is logged, and ends the member's sessions where appropriate. */
export async function changeStatus(
  ctx: AppContext,
  req: Request,
  id: string,
  action: StatusAction,
  reason: string,
  actor: Viewer,
) {
  const user = await User.findById(id);
  if (!user) throw notFound('Member not found');
  if (isStaff(user.roles as Role[])) throw new AppError(403, 'FORBIDDEN', 'Staff accounts are managed in Team');
  const before = { status: user.status, journeyState: user.journeyState };
  const from = user.journeyState as JourneyState;

  const to: { status: typeof user.status; journey: JourneyState } = (() => {
    switch (action) {
      case 'suspend':
        if (!['active', 'paused'].includes(user.status)) throw conflict('Only active or paused members can be suspended');
        return { status: 'suspended', journey: 'suspended' };
      case 'ban':
        if (['banned', 'deleted'].includes(user.status)) throw conflict('This member is already banned');
        return { status: 'banned', journey: 'banned' };
      case 'pause':
        if (user.status !== 'active') throw conflict('Only active members can be paused');
        return { status: 'paused', journey: from === 'matching_active' ? 'paused' : from };
      case 'restore': {
        if (!['suspended', 'banned', 'paused'].includes(user.status)) throw conflict('There is nothing to restore');
        const back = (user.moderation?.journeyBefore as JourneyState | undefined) ?? 'matching_active';
        return { status: 'active', journey: user.status === 'paused' ? 'matching_active' : back };
      }
    }
  })();

  if (to.journey !== from && !journeyMachine.canTransition(from, to.journey)) {
    throw conflict(`Cannot move this member from ${from} to ${to.journey}`);
  }
  const marks = action === 'suspend' || action === 'ban';
  await User.updateOne(
    { _id: id },
    {
      $set: {
        status: to.status,
        journeyState: to.journey,
        ...(marks && {
          moderation: {
            journeyBefore: from,
            statusBefore: user.status,
            reason,
            by: actor.userId,
            at: new Date(),
          },
        }),
      },
      ...(action === 'restore' && { $unset: { moderation: 1 } }),
    },
  );
  if (to.journey !== from) await logTransition('user_journey', id, from, to.journey, actor.userId, reason);
  if (marks) await revokeAllSessions(id, `staff_${action}`);

  await audit(req, {
    action: `member.${action}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: id,
    before,
    after: { status: to.status, journeyState: to.journey, reason },
  });
  await emit(`member.${action === 'restore' ? 'restored' : action === 'pause' ? 'paused_by_staff' : action === 'ban' ? 'banned' : 'suspended'}`, {
    userId: id,
  });
  return { id, status: to.status, journeyState: to.journey };
}

// ----------------------------------------------------------------- notes

export async function listNotes(id: string) {
  const rows = await AdminNote.find({ subjectUserId: id }).sort({ pinned: -1, createdAt: -1 }).limit(100).lean();
  const authors = await User.find({ _id: { $in: rows.map((r) => r.authorId) } }).select('firstName').lean();
  const name = new Map(authors.map((a) => [String(a._id), a.firstName]));
  return rows.map((n) => ({
    id: String(n._id),
    body: n.body,
    pinned: n.pinned,
    author: name.get(String(n.authorId)) ?? 'Staff',
    authorId: String(n.authorId),
    createdAt: n.createdAt,
  }));
}

export async function addNote(req: Request, id: string, authorId: string, body: string, pinned = false) {
  if (!(await User.exists({ _id: id }))) throw notFound('Member not found');
  const n = await AdminNote.create({ subjectUserId: id, authorId, body, pinned });
  await audit(req, { action: 'member.note_added', actorId: authorId, subjectType: 'user', subjectId: id, after: { noteId: String(n._id) } });
  return { id: String(n._id) };
}

export async function updateNote(
  req: Request,
  noteId: string,
  actor: { userId: string; permissions: readonly string[] },
  patch: { body?: string; pinned?: boolean },
) {
  const n = await AdminNote.findById(noteId);
  if (!n) throw notFound('Note not found');
  const mine = String(n.authorId) === actor.userId;
  if (!mine && !actor.permissions.includes('member.suspend')) {
    throw new AppError(403, 'FORBIDDEN', 'Only the author or a moderator can edit this note');
  }
  if (patch.body !== undefined) n.body = patch.body;
  if (patch.pinned !== undefined) n.pinned = patch.pinned;
  await n.save();
  await audit(req, { action: 'member.note_updated', actorId: actor.userId, subjectType: 'user', subjectId: String(n.subjectUserId) });
}

export async function deleteNote(req: Request, noteId: string, actor: { userId: string; permissions: readonly string[] }) {
  const n = await AdminNote.findById(noteId);
  if (!n) throw notFound('Note not found');
  const mine = String(n.authorId) === actor.userId;
  if (!mine && !actor.permissions.includes('member.suspend')) {
    throw new AppError(403, 'FORBIDDEN', 'Only the author or a moderator can delete this note');
  }
  await n.deleteOne();
  await audit(req, { action: 'member.note_deleted', actorId: actor.userId, subjectType: 'user', subjectId: String(n.subjectUserId) });
}

// ----------------------------------------------------------------- read-only "view as member"

/** Shows what the member sees, without issuing any session. Read-only and audited. */
export async function viewAsMember(ctx: AppContext, req: Request, id: string, actor: Viewer) {
  const user = await User.findById(id);
  if (!user) throw notFound('Member not found');
  if (isStaff(user.roles as Role[])) throw new AppError(403, 'FORBIDDEN', 'Staff accounts cannot be viewed this way');
  await audit(req, {
    action: 'member.impersonate_view',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: id,
  });
  const [me, profile, photos, assessments] = await Promise.all([
    buildMe(ctx, id, 'staff-view', false),
    getProfile(ctx, id),
    listOwnPhotos(ctx, id),
    AssessmentResponse.find({ userId: id, status: 'completed' }).select('key completedAt').lean(),
  ]);
  return { readOnly: true, me, profile, photos, assessmentsCompleted: assessments.map((a) => ({ key: a.key, completedAt: a.completedAt })) };
}
