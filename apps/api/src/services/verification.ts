import { getRetention } from './settings';
import { randomUUID } from 'node:crypto';
import {
  DEFAULTS,
  EVIDENCE_KINDS,
  EVIDENCE_MAX_BYTES,
  REJECTION_COPY,
  journeyMachine,
  type EvidenceKind,
  type JourneyState,
  type RejectionReason,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { emit, logTransition } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { FeatureFlag, User } from '../models/core';
import { Verification } from '../models/verification';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** States from which a member may start or continue verification (see the journey state machine). */
const READY: readonly string[] = ['profile_approved', 'verification_rejected', 'verification_pending'];

export const evidenceKey = (userId: string, caseId: string, kind: EvidenceKind, ext: string) =>
  `identity/${userId}/${caseId}/${kind}-${randomUUID()}.${ext}`;

type CaseDoc = NonNullable<Awaited<ReturnType<typeof Verification.findOne>>>;

export async function transitionJourney(userId: string, to: JourneyState, actorId?: string, reason?: string) {
  const user = await User.findById(userId).select('journeyState');
  if (!user) return false;
  const from = user.journeyState as JourneyState;
  if (from === to || !journeyMachine.canTransition(from, to)) return false;
  await User.updateOne({ _id: userId, journeyState: from }, { $set: { journeyState: to } });
  await logTransition('user_journey', userId, from, to, actorId, reason);
  return true;
}

async function kycAvailable(ctx: AppContext): Promise<boolean> {
  if (!ctx.kyc) return false;
  const flag = await FeatureFlag.findOne({ key: 'kyc_automated' }).lean();
  return flag?.enabled === true;
}

async function latestCase(userId: string) {
  return Verification.findOne({ userId }).sort({ createdAt: -1 });
}

async function assertReady(userId: string) {
  const user = await User.findById(userId).select('journeyState');
  if (!user) throw notFound();
  if (!READY.includes(user.journeyState)) {
    throw new AppError(
      409,
      'VERIFICATION_NOT_READY',
      'Verification opens once our team has reviewed your profile. We will let you know.',
    );
  }
}

/** The member-facing view: plain states and kind messages, never reviewer notes or evidence. */
export async function getStatus(ctx: AppContext, userId: string) {
  const [c, user, kyc, retention] = await Promise.all([latestCase(userId), User.findById(userId), kycAvailable(ctx), getRetention(ctx.env)]);
  if (!user) throw notFound();
  const evidenceDays = retention.evidenceDays;
  const state = c?.status ?? 'none';
  const uploaded = Object.fromEntries(
    EVIDENCE_KINDS.map((k) => [k, !!(c?.evidence?.[k] as { uploadedAt?: Date } | undefined)?.uploadedAt]),
  );
  return {
    state,
    method: c?.method ?? null,
    docType: c?.docType ?? null,
    docLast4: c?.docLast4 ?? null,
    uploaded,
    reuploadKinds: c?.status === 'reupload_requested' ? c.reuploadKinds : [],
    message:
      c?.status === 'rejected' && c.decisionReason
        ? REJECTION_COPY[c.decisionReason as RejectionReason]
        : c?.status === 'reupload_requested'
          ? 'We need a clearer copy of a few items. Please upload them again.'
          : null,
    submittedAt: c?.submittedAt ?? null,
    ready: READY.includes(user.journeyState),
    kycAvailable: kyc,
    badges: {
      id: !!user.verification?.idVerifiedAt,
      selfie: !!user.verification?.selfieVerifiedAt,
      phone: !!user.phoneVerifiedAt,
      email: !!user.emailVerifiedAt,
    },
    retentionDays: evidenceDays,
    retention: `Only our verification team can see these. They are deleted ${evidenceDays} days after a decision.`,
  };
}

export async function createEvidenceUpload(
  ctx: AppContext,
  userId: string,
  input: { kind: EvidenceKind; contentType: string; sizeBytes: number },
) {
  await assertReady(userId);
  if (input.sizeBytes > EVIDENCE_MAX_BYTES) throw badRequest('That file is too large');

  let c = await latestCase(userId);
  if (c && ['pending', 'in_review', 'approved'].includes(c.status)) {
    throw conflict(c.status === 'approved' ? 'You are already verified' : 'Your verification is already being reviewed');
  }
  if (!c || c.status === 'rejected') {
    c = await Verification.create({ userId, method: 'manual', status: 'draft' });
  }

  const key = evidenceKey(userId, String(c._id), input.kind, EXT[input.contentType] ?? 'bin');
  const previous = (c.evidence?.[input.kind] as { key?: string } | undefined)?.key;
  const upload = await ctx.storage.presignPut('identity', key, input.contentType, input.sizeBytes, DEFAULTS.signedUrlTtlSec);
  await Verification.updateOne(
    { _id: c._id },
    { $set: { [`evidence.${input.kind}`]: { key, contentType: input.contentType, sizeBytes: input.sizeBytes } } },
  );
  if (previous) await ctx.storage.delete('identity', previous).catch(() => undefined);
  return { caseId: String(c._id), kind: input.kind, upload };
}

/** Marks an evidence item as received once the object really exists with the declared size. */
async function confirmEvidence(ctx: AppContext, c: CaseDoc, kind: EvidenceKind): Promise<boolean> {
  const ev = c.evidence?.[kind] as { key?: string; sizeBytes?: number; uploadedAt?: Date } | undefined;
  if (!ev?.key) return false;
  if (ev.uploadedAt) return true;
  const head = await ctx.storage.head('identity', ev.key);
  if (!head || head.size !== ev.sizeBytes) return false;
  await Verification.updateOne({ _id: c._id }, { $set: { [`evidence.${kind}.uploadedAt`]: new Date() } });
  return true;
}

export async function submitManual(
  ctx: AppContext,
  userId: string,
  input: { docType: string; docLast4: string },
) {
  await assertReady(userId);
  const c = await latestCase(userId);
  if (!c || !['draft', 'reupload_requested'].includes(c.status)) {
    throw conflict('There is nothing to submit. Please upload your documents first.');
  }
  const missing: EvidenceKind[] = [];
  for (const kind of EVIDENCE_KINDS) {
    // Re-upload requests only need the requested items replaced.
    if (!(await confirmEvidence(ctx, c, kind))) missing.push(kind);
  }
  if (missing.length) {
    throw new AppError(422, 'EVIDENCE_MISSING', 'Please finish uploading your documents', { missing });
  }

  const claimed = await Verification.findOneAndUpdate(
    { _id: c._id, status: { $in: ['draft', 'reupload_requested'] } },
    {
      $set: {
        status: 'pending',
        docType: input.docType,
        docLast4: input.docLast4.toUpperCase(),
        submittedAt: new Date(),
        reuploadKinds: [],
        method: 'manual',
      },
    },
    { returnDocument: 'after' },
  );
  if (!claimed) throw conflict('Your verification was already submitted');
  await transitionJourney(userId, 'verification_pending', userId);
  await emit('verification.submitted', { userId, verificationId: String(c._id), method: 'manual' });
  return getStatus(ctx, userId);
}

/** Starts an automated session. Manual upload stays available whatever happens here. */
export async function startKyc(ctx: AppContext, userId: string) {
  await assertReady(userId);
  if (!(await kycAvailable(ctx)) || !ctx.kyc) {
    throw new AppError(501, 'NOT_AVAILABLE', 'Automated verification is not available. Please upload your documents.');
  }
  const user = await User.findById(userId).select('firstName');
  const existing = await latestCase(userId);
  if (existing && ['pending', 'in_review', 'approved'].includes(existing.status)) {
    throw conflict('Your verification is already in progress');
  }

  const c = await Verification.create({ userId, method: 'kyc', status: 'draft' });
  try {
    const session = await ctx.kycBreaker.run(() =>
      ctx.kyc!.createSession({
        referenceId: String(c._id),
        firstName: user?.firstName ?? '',
        callbackUrl: `${ctx.env.APP_URL}/verification`,
      }),
    );
    await Verification.updateOne(
      { _id: c._id },
      {
        $set: {
          status: 'pending',
          submittedAt: new Date(),
          provider: { name: ctx.kyc.name, sessionId: session.sessionId, redirectUrl: session.redirectUrl, attempts: 0 },
        },
      },
    );
    await transitionJourney(userId, 'verification_pending', userId);
    await emit('verification.submitted', { userId, verificationId: String(c._id), method: 'kyc' });
    return { verificationId: String(c._id), redirectUrl: session.redirectUrl };
  } catch (err) {
    // Provider down: leave nothing half-created and point the member at the manual route.
    await Verification.deleteOne({ _id: c._id });
    ctx.log.warn({ err }, 'kyc session creation failed');
    throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Automated verification is busy right now. You can upload your documents instead.');
  }
}
