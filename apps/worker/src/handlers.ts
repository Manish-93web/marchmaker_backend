import { buildContext } from '@marchmaker/api/context';
import type { Env } from '@marchmaker/api/env';
import { buildExport, purgeDueAccounts } from '@marchmaker/api/jobs';
import { registerMemberDataHooks } from '@marchmaker/api/purge';
import { processPhoto } from '@marchmaker/api/photo-jobs';
import { expireAndRemind, releaseDueMatches, runForMember, runNightlyIfDue } from '@marchmaker/api/matching-jobs';
import { pollPendingKyc, processKycEvent, purgeExpiredEvidence } from '@marchmaker/api/verification-jobs';
import { handleInvoiceCreated, lapseAccess, reconcile } from '@marchmaker/api/billing-jobs';
import { refreshLearnedWeights, sendCheckIns } from '@marchmaker/api/growth-jobs';
import { closeUnansweredCalls, sendSlaAlerts } from '@marchmaker/api/sla-jobs';
import { releaseReferralRewards } from '@marchmaker/api/referral-jobs';
import { closeStaleTickets } from '@marchmaker/api/support-jobs';
import { dispatchEvent, sendDueDeliveries, sendMessageDigests } from '@marchmaker/api/notification-jobs';
import { NOTIFICATION_SPECS } from '@marchmaker/shared';
import { createMailer } from '@marchmaker/api/mailer';
import { createSms } from '@marchmaker/api/sms';
import type { Logger } from 'pino';
import { registerHandler } from './queues';

export function createWorkerContext(env: Env, log: Logger) {
  return buildContext({ env, log, mailer: createMailer(env, log), sms: createSms(env, log) });
}

export type WorkerContext = ReturnType<typeof createWorkerContext>;

export function registerHandlers(ctx: WorkerContext): void {
  registerMemberDataHooks(ctx);
  registerHandler('kyc.result_received', async ({ payload }) => {
    const { eventId } = payload as { eventId: string };
    await processKycEvent(ctx, eventId);
  });
  // A change in one member's situation re-ranks only their candidates.
  for (const event of ['profile.approved', 'verification.approved', 'photo.approved', 'member.restored']) {
    registerHandler(event, async ({ payload }) => {
      const { userId } = payload as { userId: string };
      await runForMember(ctx, userId);
    });
  }
  registerHandler('invoice.created', async ({ payload }) => {
    const { invoiceId } = payload as { invoiceId: string };
    await handleInvoiceCreated(ctx, invoiceId);
  });
  // Everything a member should hear about becomes an in-app note plus whichever channels they allow.
  for (const eventType of [...Object.keys(NOTIFICATION_SPECS), 'safety.critical_report']) {
    registerHandler(eventType, async ({ payload }, job) => {
      await dispatchEvent(ctx, eventType, (payload ?? {}) as Record<string, unknown>, String(job.id));
    });
  }
  registerHandler('photo.uploaded', async ({ payload }) => {
    const { photoId } = payload as { photoId: string };
    await processPhoto(ctx, photoId);
  });
  registerHandler('account.export_requested', async ({ payload }) => {
    const { dataRequestId } = payload as { dataRequestId: string };
    await buildExport(ctx, dataRequestId);
  });
}

/** Periodic sweeps that are not triggered by a domain event. */
export async function runSweeps(ctx: WorkerContext): Promise<void> {
  await purgeDueAccounts(ctx);
  await purgeExpiredEvidence(ctx);
  await pollPendingKyc(ctx);
  await runNightlyIfDue(ctx);
  await reconcile(ctx);
  await lapseAccess();
  await closeStaleTickets();
  await releaseReferralRewards();
  await sendCheckIns();
  await refreshLearnedWeights();
  await sendMessageDigests();
  await sendSlaAlerts(ctx);
}

/** Runs every minute: releases matches whose cool-off ended and wakes snoozed ones. */
export async function runReleaseTick(ctx: WorkerContext): Promise<void> {
  await releaseDueMatches(ctx);
  await sendDueDeliveries(ctx);
  await expireAndRemind();
  await closeUnansweredCalls();
}
