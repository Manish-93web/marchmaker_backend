import type { AppContext } from '../context';
import { Photo, Preference, Profile } from '../models/profile';
import { allPhotoKeys } from '../services/photos';
import { AssessmentResponse } from '../models/assessment';
import { Verification } from '../models/verification';
import { AstroProfile, AstroReport, CallLog } from '../models/extras';
import { Block, Introduction } from '../models/matching';
import { CreditLedger, Message, MessageThread, Report } from '../models/social';
import { withTransaction } from '../db/connection';
import * as credits from '../services/credits';
import { EVIDENCE_KINDS } from '@marchmaker/shared';
import { registerExportCollector, registerPurgeHook } from './accountJobs';
import { presentProfile } from '../services/profile';
import { GuideProgress } from '../models/content';
import { CheckinMarker, IntroFeedback } from '../models/growth';
import { WhatsAppOptIn } from '../models/messaging';
import { Delivery, Notification, PushSubscription } from '../models/notifications';
import { Ticket, TicketMessage } from '../models/safety';
import { SavedFilter } from '../models/cms';

/** Wires profile, preference and photo data into account export and hard deletion. */
export function registerMemberDataHooks(ctx: AppContext): void {
  registerPurgeHook(async (userId) => {
    const keys = await allPhotoKeys(userId);
    await Promise.all(keys.map((k) => ctx.storage.delete('photos', k).catch(() => undefined)));
    await Promise.all([
      Photo.deleteMany({ userId }),
      Profile.deleteOne({ userId }),
      Preference.deleteOne({ userId }),
      AssessmentResponse.deleteMany({ userId }),
    ]);
    // Identity evidence goes first: delete the objects, then the case records.
    const cases = await Verification.find({ userId }).lean();
    for (const c of cases) {
      for (const kind of EVIDENCE_KINDS) {
        const key = (c.evidence?.[kind] as { key?: string } | undefined)?.key;
        if (key) await ctx.storage.delete('identity', key).catch(() => undefined);
      }
    }
    await Verification.deleteMany({ userId });

    // Conversations: remove what this member wrote, close the threads, end open introductions
    // (returning the other person's held credit), and drop the member's blocks.
    await Message.deleteMany({ senderId: userId });
    await MessageThread.updateMany({ members: userId }, { $set: { status: 'closed', closedReason: 'member_deleted' } });
    const open = await Introduction.find({ 'members.userId': userId, state: { $in: ['released', 'viewed', 'accepted_by_one'] } });
    for (const intro of open) {
      await withTransaction(async (session) => {
        const fresh = await Introduction.findById(intro._id).session(session);
        if (!fresh) return;
        for (const m of fresh.members) {
          if (m.status === 'accepted' && String(m.userId) !== userId) {
            await credits.release(m.userId, fresh._id, 'other member left', session);
          }
        }
        fresh.state = 'declined';
        fresh.closedReason = 'member_deleted';
        await fresh.save({ session });
      });
    }
    await Introduction.updateMany(
      { 'members.userId': userId },
      { $unset: { 'members.$[m].firstNote': 1, 'members.$[m].declineNote': 1 } },
      { arrayFilters: [{ 'm.userId': userId }] },
    );
    await Block.deleteMany({ blockerId: userId });
    // Birth details and every reading that used them, and the call records this member started.
    await Promise.all([
      AstroProfile.deleteOne({ userId }),
      AstroReport.deleteMany({ $or: [{ userId }, { memberIds: userId }] }),
      CallLog.deleteMany({ initiatedBy: userId }),
    ]);
  });

  // Everything else that is only about this member: inbox, devices, feedback, reading progress, WhatsApp consent
  // record and support conversations (including files they attached). Reports and ledgers stay as legal evidence.
  registerPurgeHook(async (userId) => {
    const tickets = await Ticket.find({ userId }).select('_id').lean();
    const files = (await TicketMessage.find({ ticketId: { $in: tickets.map((t) => t._id) }, 'attachments.0': { $exists: true } }).select('attachments').lean()).flatMap((m) => (m.attachments ?? []).map((a) => a.key));
    await Promise.all(files.filter(Boolean).map((k) => ctx.storage.delete('documents', k as string).catch(() => undefined)));
    await Promise.all([
      Notification.deleteMany({ userId }),
      Delivery.deleteMany({ userId }),
      PushSubscription.deleteMany({ userId }),
      IntroFeedback.deleteMany({ userId }),
      CheckinMarker.deleteMany({ userId }),
      GuideProgress.deleteMany({ userId }),
      WhatsAppOptIn.deleteMany({ userId }),
      SavedFilter.deleteMany({ userId }),
      TicketMessage.deleteMany({ ticketId: { $in: tickets.map((t) => t._id) } }),
      Ticket.deleteMany({ userId }),
    ]);
  });

  registerExportCollector('guideProgress', async (userId) => (await GuideProgress.find({ userId }).select('slug positionSec speed completed').lean()).map((g) => ({ slug: g.slug, positionSec: g.positionSec, speed: g.speed, completed: g.completed })));
  registerExportCollector('feedback', async (userId) => (await IntroFeedback.find({ userId }).select('stage rating met tags note createdAt').lean()).map((f) => ({ stage: f.stage, rating: f.rating ?? null, met: f.met ?? null, tags: f.tags, note: f.note ?? null, at: f.createdAt })));
  registerExportCollector('support', async (userId) => {
    const tickets = await Ticket.find({ userId }).lean();
    const out = [];
    for (const t of tickets) {
      const msgs = await TicketMessage.find({ ticketId: t._id, internal: false }).sort({ _id: 1 }).lean();
      out.push({ number: t.number, subject: t.subject, category: t.category, status: t.status, messages: msgs.map((m) => ({ author: m.author, body: m.body, at: m.createdAt })) });
    }
    return out;
  });

  registerExportCollector('profile', async (userId) => {
    const p = await Profile.findOne({ userId });
    if (!p) return null;
    const count = await Photo.countDocuments({ userId, status: { $in: ['pending', 'approved'] } });
    const { data, status, submittedAt } = presentProfile(ctx, p, count);
    return { status, submittedAt, data };
  });
  // Answers and written results are the member's data. Internal dimension scores are not exported.
  registerExportCollector('assessments', async (userId) => {
    const rows = await AssessmentResponse.find({ userId, status: 'completed' }).lean();
    return rows.map((r) => ({
      assessment: r.key,
      completedAt: r.completedAt,
      answers: r.answers,
      result: (r.narrative as { sections?: { heading: string; body: string }[] } | undefined)?.sections ?? [],
    }));
  });
  // Decision record only; identity images are never part of an export.
  registerExportCollector('verification', async (userId) => {
    const rows = await Verification.find({ userId }).select('method status docType docLast4 submittedAt decidedAt').lean();
    return rows.map((r) => ({
      method: r.method,
      status: r.status,
      documentType: r.docType ?? null,
      documentLast4: r.docLast4 ?? null,
      submittedAt: r.submittedAt ?? null,
      decidedAt: r.decidedAt ?? null,
    }));
  });
  registerExportCollector('introductions', async (userId) => {
    const rows = await Introduction.find({ 'members.userId': userId }).lean();
    return rows.map((i) => {
      const me = i.members.find((m) => String(m.userId) === userId);
      return {
        state: i.state,
        releasedAt: i.releasedAt,
        whyWeIntroducedYou: i.whyText,
        myResponse: me?.status ?? null,
        myFirstNote: me?.firstNote ?? null,
        myDeclineReason: me?.declineReason ?? null,
      };
    });
  });
  registerExportCollector('messagesSent', async (userId) => {
    const rows = await Message.find({ senderId: userId }).sort({ createdAt: 1 }).limit(5000).lean();
    return rows.map((m) => ({ at: m.createdAt, body: m.body }));
  });
  registerExportCollector('reportsMade', async (userId) => {
    const rows = await Report.find({ reporterId: userId }).lean();
    return rows.map((r) => ({ category: r.category, status: r.status, at: r.createdAt }));
  });
  registerExportCollector('creditHistory', async (userId) => {
    const rows = await CreditLedger.find({ userId }).sort({ createdAt: 1 }).lean();
    return rows.map((r) => ({ type: r.type, delta: r.delta, reason: r.reason ?? null, at: r.createdAt }));
  });
  registerExportCollector('preferences', async (userId) => (await Preference.findOne({ userId }).lean())?.dimensions ?? []);
  registerExportCollector('photos', async (userId) => {
    const rows = await Photo.find({ userId }).select('status isPrimary order createdAt').lean();
    return rows.map((r) => ({ status: r.status, isPrimary: r.isPrimary, order: r.order, uploadedAt: r.createdAt }));
  });
}
