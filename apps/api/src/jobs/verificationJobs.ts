import { getRetention } from '../services/settings';
import { EVIDENCE_KINDS, evaluateKycResult, type KycResult } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { User } from '../models/core';
import { Verification, WebhookEvent } from '../models/verification';
import { transitionJourney } from '../services/verification';

const MAX_PROVIDER_ATTEMPTS = 6;
const POLL_AFTER_MS = 5 * 60_000;
const DAY = 86_400_000;

type VerificationDoc = NonNullable<Awaited<ReturnType<typeof Verification.findOne>>>;

/** Applies the automation policy: approve when certain, otherwise hand to a person. */
async function applyResult(ctx: AppContext, v: VerificationDoc, result: KycResult): Promise<void> {
  const outcome = evaluateKycResult(result);
  const userId = String(v.userId);
  const providerFields = {
    'provider.confidence': result.confidence,
    'provider.faceMatch': result.faceMatch,
    'provider.livenessPassed': result.livenessPassed,
    'provider.nameMatch': result.nameMatch,
    'provider.dobMatch': result.dobMatch,
    'provider.lastError': null,
  };

  if (outcome.action === 'wait') {
    await Verification.updateOne({ _id: v._id }, { $set: { 'provider.lastPolledAt': new Date() } });
    return;
  }

  if (outcome.action === 'approve') {
    const now = new Date();
    const claimed = await Verification.findOneAndUpdate(
      { _id: v._id, status: { $in: ['pending', 'in_review'] } },
      {
        $set: {
          ...providerFields,
          status: 'approved',
          decidedBy: 'provider',
          decidedAt: now,
          docType: result.docType ?? v.docType,
          docLast4: result.docLast4 ?? v.docLast4,
          purgeAfter: new Date(now.getTime() + (await getRetention(ctx.env)).evidenceDays * DAY),
        },
      },
    );
    if (!claimed) return;
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'verification.idVerifiedAt': now,
          'verification.selfieVerifiedAt': now,
          'verification.livenessVerifiedAt': now,
        },
      },
    );
    await transitionJourney(userId, 'verified', undefined, 'kyc auto-approved');
    await transitionJourney(userId, 'matching_active', undefined, 'verified members are matchable');
    await audit(undefined, { action: 'verification.auto_approved', subjectType: 'verification', subjectId: String(v._id) });
    await emit('verification.approved', { userId, verificationId: String(v._id) });
    return;
  }

  await Verification.updateOne(
    { _id: v._id, status: { $in: ['pending', 'in_review'] } },
    { $set: { ...providerFields, status: 'in_review', manualReason: outcome.reason } },
  );
  await emit('verification.needs_review', { userId, verificationId: String(v._id), reason: outcome.reason });
}

/** Handles one persisted provider callback. Safe to run more than once for the same event. */
export async function processKycEvent(ctx: AppContext, eventId: string): Promise<void> {
  if (!ctx.kyc) return;
  const ev = await WebhookEvent.findOne({ provider: ctx.kyc.name, eventId });
  if (!ev || ev.processedAt) return;

  const sessionId = (ev.payload as { sessionId?: string } | undefined)?.sessionId;
  const v = sessionId ? await Verification.findOne({ 'provider.sessionId': sessionId }) : null;
  if (!v) {
    await WebhookEvent.updateOne({ _id: ev._id }, { $set: { processedAt: new Date(), error: 'unknown session' } });
    return;
  }

  try {
    // The callback only says "something changed"; the result is always fetched from the provider.
    const result = await ctx.kycBreaker.run(() => ctx.kyc!.getResult(sessionId!));
    await applyResult(ctx, v, result);
    await WebhookEvent.updateOne({ _id: ev._id }, { $set: { processedAt: new Date(), error: null }, $inc: { attempts: 1 } });
  } catch (err) {
    await WebhookEvent.updateOne(
      { _id: ev._id },
      { $inc: { attempts: 1 }, $set: { error: err instanceof Error ? err.message.slice(0, 300) : 'error' } },
    );
    throw err; // the queue retries with backoff; the poller is the safety net
  }
}

/**
 * Safety net for lost or delayed callbacks and provider outages: re-checks pending sessions,
 * and after repeated failures routes the case to manual review so the member is never stuck.
 */
export async function pollPendingKyc(ctx: AppContext, now: Date = new Date()): Promise<number> {
  if (!ctx.kyc) return 0;
  const cutoff = new Date(now.getTime() - POLL_AFTER_MS);
  const due = await Verification.find({
    method: 'kyc',
    status: 'pending',
    'provider.sessionId': { $exists: true },
    $or: [{ 'provider.lastPolledAt': { $exists: false } }, { 'provider.lastPolledAt': { $lte: cutoff } }],
    submittedAt: { $lte: cutoff },
  }).limit(100);

  let handled = 0;
  for (const v of due) {
    try {
      const result = await ctx.kycBreaker.run(() => ctx.kyc!.getResult(v.provider!.sessionId!));
      await Verification.updateOne({ _id: v._id }, { $set: { 'provider.lastPolledAt': now } });
      await applyResult(ctx, v, result);
      handled++;
    } catch (err) {
      const attempts = (v.provider?.attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_PROVIDER_ATTEMPTS;
      await Verification.updateOne(
        { _id: v._id, status: 'pending' },
        {
          $set: {
            'provider.attempts': attempts,
            'provider.lastPolledAt': now,
            'provider.lastError': err instanceof Error ? err.message.slice(0, 300) : 'error',
            ...(giveUp && { status: 'in_review', manualReason: 'provider_error' }),
          },
        },
      );
      if (giveUp) await emit('verification.needs_review', { userId: String(v.userId), verificationId: String(v._id), reason: 'provider_error' });
    }
  }
  return handled;
}

/**
 * Retention: raw identity images are deleted a fixed time after a decision. The decision,
 * document type, last four characters and reviewer id remain.
 */
export async function purgeExpiredEvidence(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const due = await Verification.find({ purgeAfter: { $lte: now }, evidencePurgedAt: { $exists: false } }).limit(200);
  for (const v of due) {
    for (const kind of EVIDENCE_KINDS) {
      const ev = v.evidence?.[kind] as { key?: string } | undefined;
      if (ev?.key) await ctx.storage.delete('identity', ev.key).catch((err) => ctx.log.warn({ err }, 'evidence delete failed'));
    }
    await Verification.updateOne(
      { _id: v._id },
      {
        $set: { evidencePurgedAt: now },
        $unset: Object.fromEntries(EVIDENCE_KINDS.flatMap((k) => [[`evidence.${k}.key`, 1], [`evidence.${k}.contentType`, 1]])),
      },
    );
    for (const kind of EVIDENCE_KINDS) {
      await Verification.updateOne({ _id: v._id, [`evidence.${kind}`]: { $exists: true } }, { $set: { [`evidence.${kind}.purgedAt`]: now } });
    }
    await audit(undefined, { action: 'verification.evidence_purged', subjectType: 'verification', subjectId: String(v._id) });
  }
  return due.length;
}
