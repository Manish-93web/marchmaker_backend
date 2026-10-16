import { getRetention } from './settings';
import {
  DECISION_CHECKLIST,
  DEFAULTS,
  EVIDENCE_KINDS,
  ageOn,
  type EvidenceKind,
  type VerificationDecision,
} from '@marchmaker/shared';
import type { Request } from 'express';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Photo, Profile } from '../models/profile';
import { Verification } from '../models/verification';
import { transitionJourney } from './verification';

const OPEN = ['pending', 'in_review'] as const;
const DAY = 86_400_000;

export async function queue(status: 'pending' | 'in_review' | 'all' = 'all', limit = 50) {
  const rows = await Verification.find({ status: status === 'all' ? { $in: OPEN } : status })
    .sort({ submittedAt: 1 })
    .limit(limit)
    .lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } })
    .select('firstName gender')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const now = Date.now();
  return rows.map((r) => ({
    id: String(r._id),
    userId: String(r.userId),
    firstName: byId.get(String(r.userId))?.firstName ?? '',
    method: r.method,
    status: r.status,
    docType: r.docType ?? null,
    manualReason: r.manualReason ?? null,
    submittedAt: r.submittedAt ?? null,
    waitingHours: r.submittedAt ? Math.round((now - r.submittedAt.getTime()) / 3_600_000) : null,
  }));
}

/**
 * Case detail for a verifier. Issuing evidence links is the sensitive act, so every call is
 * written to the audit log with the actor and the exact items viewed.
 */
export async function detail(ctx: AppContext, req: Request, id: string, actorId: string, roles: string[]) {
  const c = await Verification.findById(id);
  if (!c) throw notFound('Verification not found');
  const user = await User.findById(c.userId);
  if (!user) throw notFound();

  const profile = await Profile.findOne({ userId: c.userId }).lean();
  const photo = await Photo.findOne({ userId: c.userId, status: { $in: ['pending', 'approved'] } })
    .sort({ isPrimary: -1, order: 1 })
    .lean();

  const links: Partial<Record<EvidenceKind, string>> = {};
  const viewed: EvidenceKind[] = [];
  for (const kind of EVIDENCE_KINDS) {
    const ev = c.evidence?.[kind] as { key?: string; purgedAt?: Date } | undefined;
    if (ev?.key && !ev.purgedAt) {
      links[kind] = await ctx.storage.presignGet('identity', ev.key, DEFAULTS.signedUrlTtlSec);
      viewed.push(kind);
    }
  }
  const profilePhoto = photo?.variants?.md ? await ctx.storage.presignGet('photos', photo.variants.md, DEFAULTS.signedUrlTtlSec) : null;

  await audit(req, {
    action: 'verification.view_evidence',
    actorId,
    actorRoles: roles,
    subjectType: 'verification',
    subjectId: id,
    after: { kinds: viewed, memberId: String(c.userId) },
  });

  if (c.status === 'pending') {
    await Verification.updateOne({ _id: c._id, status: 'pending' }, { $set: { status: 'in_review' } });
  }

  const basics = ((profile?.data ?? {}) as Record<string, Record<string, unknown>>).basics ?? {};
  const dob = ctx.crypto.decrypt(user.dobEnc);
  return {
    id,
    status: c.status === 'pending' ? 'in_review' : c.status,
    method: c.method,
    manualReason: c.manualReason ?? null,
    docType: c.docType ?? null,
    docLast4: c.docLast4 ?? null,
    member: {
      id: String(user._id),
      firstName: user.firstName,
      lastName: (basics.lastName as string | undefined) ?? null,
      gender: user.gender,
      dateOfBirth: dob,
      age: ageOn(new Date(dob)),
    },
    evidence: links,
    evidencePurged: !!c.evidencePurgedAt,
    profilePhoto,
    provider: c.provider
      ? {
          name: c.provider.name,
          confidence: c.provider.confidence ?? null,
          faceMatch: c.provider.faceMatch ?? null,
          livenessPassed: c.provider.livenessPassed ?? null,
          nameMatch: c.provider.nameMatch ?? null,
          dobMatch: c.provider.dobMatch ?? null,
        }
      : null,
    checklistKeys: DECISION_CHECKLIST,
    linkTtlSeconds: DEFAULTS.signedUrlTtlSec,
  };
}

export async function decide(
  ctx: AppContext,
  req: Request,
  id: string,
  actorId: string,
  roles: string[],
  d: VerificationDecision,
) {
  const c = await Verification.findById(id);
  if (!c) throw notFound('Verification not found');
  if (!(OPEN as readonly string[]).includes(c.status)) throw conflict('This verification has already been decided');
  const userId = String(c.userId);
  const now = new Date();
  const retention = (await getRetention(ctx.env)).evidenceDays * DAY;

  if (d.decision === 'approve') {
    const failed = DECISION_CHECKLIST.filter((k) => !d.checklist[k]);
    if (failed.length) {
      throw new AppError(422, 'CHECKLIST_INCOMPLETE', 'Every check must pass to approve. Reject or request a re-upload instead.', {
        failed,
      });
    }
    const claimed = await Verification.findOneAndUpdate(
      { _id: id, status: { $in: OPEN } },
      {
        $set: {
          status: 'approved',
          checklist: d.checklist,
          reviewerId: actorId,
          decidedBy: 'staff',
          decidedAt: now,
          purgeAfter: new Date(now.getTime() + retention),
        },
      },
    );
    if (!claimed) throw conflict('This verification has already been decided');
    await User.updateOne(
      { _id: userId },
      { $set: { 'verification.idVerifiedAt': now, 'verification.selfieVerifiedAt': now } },
    );
    await transitionJourney(userId, 'verified', actorId, 'verification approved');
    await transitionJourney(userId, 'matching_active', actorId, 'verified members are matchable');
    await emit('verification.approved', { userId, verificationId: id });
  } else if (d.decision === 'reject') {
    const claimed = await Verification.findOneAndUpdate(
      { _id: id, status: { $in: OPEN } },
      {
        $set: {
          status: 'rejected',
          decisionReason: d.reason,
          decisionNote: d.note,
          reviewerId: actorId,
          decidedBy: 'staff',
          decidedAt: now,
          purgeAfter: new Date(now.getTime() + retention),
        },
      },
    );
    if (!claimed) throw conflict('This verification has already been decided');
    await transitionJourney(userId, 'verification_rejected', actorId, d.reason);
    await emit('verification.rejected', { userId, verificationId: id, reason: d.reason });
  } else {
    const claimed = await Verification.findOneAndUpdate(
      { _id: id, status: { $in: OPEN } },
      {
        $set: {
          status: 'reupload_requested',
          reuploadKinds: d.kinds,
          decisionNote: d.note,
          reviewerId: actorId,
        },
        // The old file is discarded: a new one must be uploaded, not the same one resubmitted.
        $unset: Object.fromEntries(d.kinds.map((k) => [`evidence.${k}`, 1])),
      },
    );
    if (!claimed) throw conflict('This verification has already been decided');
    for (const kind of d.kinds) {
      const key = (claimed.evidence?.[kind] as { key?: string } | undefined)?.key;
      if (key) await ctx.storage.delete('identity', key).catch(() => undefined);
    }
    await emit('verification.reupload_requested', { userId, verificationId: id, kinds: d.kinds });
  }

  await audit(req, {
    action: `verification.${d.decision}`,
    actorId,
    actorRoles: roles,
    subjectType: 'verification',
    subjectId: id,
    after: d.decision === 'approve' ? { checklist: d.checklist } : d,
  });
  return { id, decision: d.decision };
}
