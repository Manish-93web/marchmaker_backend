import { Introduction } from "../models/Introduction.js";
import { IntroductionEvent } from "../models/IntroductionEvent.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { VerificationRequest } from "../models/VerificationRequest.js";
import { Assessment } from "../models/Assessment.js";
import { DataDeletionRequest } from "../models/ConsentRecord.js";
import { ReconciliationService } from "./reconciliationService.js";
import { AuditLog } from "../models/AuditLog.js";
import { Notification } from "../models/Notification.js";

export class CronService {
  private static timer: NodeJS.Timeout | null = null;

  /**
   * Initialize background schedulers.
   * Runs recurring checks every hour (and once immediately on startup).
   */
  static init(intervalMs = 60 * 60 * 1000) {
    console.log("[CronService] Initializing automated background workers...");
    // Run initial pass after 5 seconds
    setTimeout(() => {
      CronService.runAllJobs().catch((err) => {
        console.error("[CronService] Error in startup cron pass:", err);
      });
    }, 5000);

    // Schedule regular recurring executions
    this.timer = setInterval(() => {
      CronService.runAllJobs().catch((err) => {
        console.error("[CronService] Error in recurring cron pass:", err);
      });
    }, intervalMs);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static async runAllJobs() {
    const results = {
      expiredIntroductions: await CronService.expireStaleIntroductions(),
      dpdpPurges: await CronService.processDataDeletionRequests(),
      reconciliation: await CronService.runDailyReconciliation(),
    };
    return results;
  }

  /**
   * 1. 7-day SLA: Automatically expires introductions offered more than 7 days ago without member action.
   */
  static async expireStaleIntroductions(daysThreshold = 7): Promise<number> {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000);

    const staleIntroductions = await Introduction.find({
      status: "OFFERED",
      updatedAt: { $lte: cutoff },
    });

    let expiredCount = 0;
    for (const intro of staleIntroductions) {
      intro.status = "EXPIRED";
      await intro.save();

      await IntroductionEvent.create({
        introductionId: intro._id,
        fromStatus: "OFFERED",
        toStatus: "EXPIRED",
        triggeredBy: intro.reviewerId || intro.member1Id,
        metadata: { reason: "7_DAY_SLA_AUTO_EXPIRATION" },
      });

      // Notify both members
      await Notification.create([
        {
          userId: intro.member1Id,
          type: "INTRODUCTION_UPDATE",
          title: "Introduction Expired",
          message: "A pending introduction has expired as the response window concluded.",
          link: "/dashboard/introductions",
        },
        {
          userId: intro.member2Id,
          type: "INTRODUCTION_UPDATE",
          title: "Introduction Expired",
          message: "A pending introduction has expired as the response window concluded.",
          link: "/dashboard/introductions",
        },
      ]);

      expiredCount++;
    }

    if (expiredCount > 0) {
      console.log(`[CronService] Auto-expired ${expiredCount} stale introductions.`);
    }
    return expiredCount;
  }

  /**
   * 2. DPDP Act 2023: Permanently anonymizes/deletes data when 30-day grace period has elapsed.
   * Retains financial tax invoices (required by Indian GST laws for 7 years).
   */
  static async processDataDeletionRequests(): Promise<number> {
    const dueRequests = await DataDeletionRequest.find({
      status: "PENDING",
      scheduledDeletionDate: { $lte: new Date() },
    });

    let purgedCount = 0;
    for (const req of dueRequests) {
      const userId = req.userId;

      // 1. Delete member profiles & preferences
      await MemberProfile.deleteOne({ userId });
      // 2. Invalidate all active sessions
      await Session.deleteMany({ userId });
      // 3. Remove KYC verification evidence
      await VerificationRequest.deleteMany({ userId });
      // 4. Remove assessments
      await Assessment.deleteMany({ userId });

      // 5. Anonymize user record
      await User.findByIdAndUpdate(userId, {
        fullName: "Deleted User (DPDP Purged)",
        email: `purged_${userId}_${Date.now()}@anonymized.internal`,
        phone: undefined,
        isSuspended: true,
        suspendedReason: "DPDP_ACT_RIGHT_TO_ERASURE_COMPLETED",
      });

      // Update deletion request status
      req.status = "COMPLETED";
      req.completedAt = new Date();
      await req.save();

      // Log immutable audit record
      await AuditLog.create({
        actorRole: "SYSTEM",
        action: "DPDP_30_DAY_GRACE_PURGE_EXECUTED",
        targetCollection: "User",
        targetId: userId.toString(),
        details: { requestId: req._id.toString() },
      });

      purgedCount++;
    }

    if (purgedCount > 0) {
      console.log(`[CronService] Processed ${purgedCount} DPDP erasure requests.`);
    }
    return purgedCount;
  }

  /**
   * 3. Daily Reconciliation: Audits captured payments vs invoices and logs anomalies.
   */
  static async runDailyReconciliation(): Promise<any> {
    const summary = await ReconciliationService.getSummary(1); // last 24h
    if (summary.discrepancies.length > 0) {
      await AuditLog.create({
        actorRole: "SYSTEM",
        action: "RECONCILIATION_DISCREPANCIES_DETECTED",
        targetCollection: "Payment",
        targetId: "SYSTEM_RECON",
        details: { discrepancies: summary.discrepancies },
      });
      console.warn(`[CronService] Reconciliation alert: ${summary.discrepancies.length} discrepancy found.`);
    }
    return summary;
  }
}
