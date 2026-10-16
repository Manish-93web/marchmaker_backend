import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context';
import { audit, logTransition } from '../lib/audit';
import { exportLinkSig } from '../routes/account';
import { AuthToken, Consent, DataRequest, OtpCode } from '../models/auth';
import { Session, User } from '../models/core';
import { sendNotice } from '../services/notify';

const DAY = 86_400_000;

type Collector = (userId: string) => Promise<unknown>;
type PurgeHook = (userId: string) => Promise<void>;
const collectors = new Map<string, Collector>();
const purgeHooks: PurgeHook[] = [];

/** Later phases register what belongs in a member's data export (profile, photos, messages...). */
export function registerExportCollector(name: string, fn: Collector): void {
  collectors.set(name, fn);
}
/** Later phases register cleanup (storage objects, search indexes...) that must run before hard delete. */
export function registerPurgeHook(fn: PurgeHook): void {
  purgeHooks.push(fn);
}

export async function buildExport(ctx: AppContext, dataRequestId: string): Promise<void> {
  const dr = await DataRequest.findOneAndUpdate(
    { _id: dataRequestId, kind: 'export', status: 'pending' },
    { $set: { status: 'processing' } },
  );
  if (!dr) return; // already handled: the job is idempotent

  try {
    const userId = String(dr.userId);
    const user = await User.findById(userId).lean();
    if (!user) throw new Error('user not found');

    const [consents, sessions, requests] = await Promise.all([
      Consent.find({ userId }).sort({ createdAt: 1 }).lean(),
      Session.find({ userId }).select('userAgent ip createdAt lastSeenAt revokedAt').lean(),
      DataRequest.find({ userId }).select('kind status createdAt').lean(),
    ]);
    const extra: Record<string, unknown> = {};
    for (const [name, fn] of collectors) extra[name] = await fn(userId);

    const payload = {
      generatedAt: new Date().toISOString(),
      account: {
        id: userId,
        email: user.email ?? null,
        phone: user.phoneEnc ? ctx.crypto.decrypt(user.phoneEnc) : null,
        firstName: user.firstName,
        gender: user.gender,
        dateOfBirth: ctx.crypto.decrypt(user.dobEnc),
        status: user.status,
        journeyState: user.journeyState,
        locale: user.locale,
        createdAt: user.createdAt,
        notificationPrefs: user.notificationPrefs,
      },
      consents,
      sessions,
      dataRequests: requests,
      ...extra,
    };

    await mkdir(ctx.env.EXPORT_DIR, { recursive: true });
    const key = `${dataRequestId}.json`;
    await writeFile(path.resolve(ctx.env.EXPORT_DIR, key), JSON.stringify(payload, null, 2), { mode: 0o600 });

    const expiresAt = new Date(Date.now() + 7 * DAY);
    await DataRequest.updateOne(
      { _id: dataRequestId },
      { $set: { status: 'ready', resultKey: key, expiresAt, completedAt: new Date() } },
    );

    if (user.email) {
      const sig = exportLinkSig(ctx.env.JWT_REFRESH_SECRET, dataRequestId, expiresAt.getTime());
      const url = `${ctx.env.APP_URL}/api/v1/account/exports/${dataRequestId}/download?exp=${expiresAt.getTime()}&sig=${sig}`;
      await sendNotice(ctx, user.email, {
        subject: 'Your data export is ready',
        preview: 'Download your Marchmaker data',
        heading: 'Your data export is ready',
        paragraphs: ['You can download a copy of your data using the button below. The link works for 7 days.'],
        cta: { label: 'Download my data', url },
        footnote: 'Anyone with this link can download your data. Do not forward this email.',
      });
    }
  } catch (err) {
    ctx.log.error({ err, dataRequestId }, 'export failed');
    await DataRequest.updateOne(
      { _id: dataRequestId },
      { $set: { status: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'error' } },
    );
    throw err; // lets the queue retry with backoff
  }
}

/** Hard-deletes members whose 14-day grace period has ended. Returns how many were purged. */
export async function purgeDueAccounts(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const candidates = await User.find({ status: 'deletion_scheduled', deletionScheduledFor: { $lte: now } })
    .select('_id email firstName')
    .limit(100)
    .lean();
  // A deletion that is still waiting for a super admin is held, however long ago the grace period ended.
  const held = new Set(
    (await DataRequest.find({ userId: { $in: candidates.map((c) => c._id) }, kind: 'deletion', status: 'awaiting_approval' }).select('userId').lean()).map((r) => String(r.userId)),
  );
  const due = candidates.filter((c) => !held.has(String(c._id)));
  let purged = 0;

  for (const u of due) {
    const id = String(u._id);
    try {
      for (const hook of purgeHooks) await hook(id);

      const exports = await DataRequest.find({ userId: id, kind: 'export', resultKey: { $exists: true } }).lean();
      for (const e of exports) {
        await rm(path.resolve(ctx.env.EXPORT_DIR, path.basename(String(e.resultKey))), { force: true });
      }
      await Promise.all([
        Session.deleteMany({ userId: id }),
        AuthToken.deleteMany({ userId: id }),
        OtpCode.deleteMany({ target: { $in: u.email ? [u.email] : [] } }),
      ]);
      // Consent history and audit trail are kept as pseudonymous legal evidence (docs/DATA_RETENTION.md).
      await DataRequest.updateMany({ userId: id, kind: 'deletion' }, { $set: { status: 'completed', completedAt: now } });
      await User.deleteOne({ _id: id });
      await logTransition('user_journey', id, 'deletion_scheduled', 'deleted', undefined, 'grace period ended');
      await audit(undefined, { action: 'account.purged', subjectType: 'user', subjectId: id });
      purged++;

      if (u.email) {
        await sendNotice(ctx, u.email, {
          subject: 'Your Marchmaker account has been deleted',
          preview: 'Your data has been deleted',
          heading: 'Your account has been deleted',
          paragraphs: ['As you asked, your profile and personal data have been permanently deleted.'],
        });
      }
    } catch (err) {
      ctx.log.error({ err, userId: id }, 'account purge failed');
    }
  }
  return purged;
}
