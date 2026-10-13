import { Types } from "mongoose";
import { Report, BlockedUser, IReport, ReportSeverity } from "../models/Report.js";
import { User } from "../models/User.js";
import { Introduction } from "../models/Introduction.js";
import { AuditLog } from "../models/AuditLog.js";

export class ModerationService {
  static async reportUser(data: {
    reporterId: string;
    reportedUserId: string;
    introductionId?: string;
    reason: string;
    details: string;
    severity?: ReportSeverity;
  }): Promise<IReport> {
    const report = await Report.create({
      reporterId: new Types.ObjectId(data.reporterId),
      reportedUserId: new Types.ObjectId(data.reportedUserId),
      introductionId: data.introductionId ? new Types.ObjectId(data.introductionId) : undefined,
      reason: data.reason,
      details: data.details,
      severity: data.severity || "MEDIUM",
      status: "PENDING",
    });

    // Automatically block the reported user for the reporter's safety
    await this.blockUser(data.reporterId, data.reportedUserId);

    return report;
  }

  static async blockUser(userId: string, blockedUserId: string): Promise<boolean> {
    await BlockedUser.findOneAndUpdate(
      { userId, blockedUserId },
      { userId, blockedUserId },
      { upsert: true }
    );

    // Cancel any active introduction between these two users
    await Introduction.updateMany(
      {
        $or: [
          { member1Id: userId, member2Id: blockedUserId },
          { member1Id: blockedUserId, member2Id: userId },
        ],
        status: { $in: ["PENDING_REVIEW", "OFFERED", "PAYMENT_PENDING", "UNLOCKED"] },
      },
      {
        $set: { status: "CANCELLED" },
      }
    );

    return true;
  }

  static async getPendingReports(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      Report.find({ status: "PENDING" })
        .populate("reporterId", "fullName email")
        .populate("reportedUserId", "fullName email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Report.countDocuments({ status: "PENDING" }),
    ]);

    return { reports, total, page, totalPages: Math.ceil(total / limit) };
  }

  static async actionReport(data: {
    reportId: string;
    moderatorId: string;
    action: "NO_ACTION" | "WARNING_ISSUED" | "PROFILE_SUSPENDED" | "PERMANENT_BAN";
    moderatorNotes?: string;
  }): Promise<IReport> {
    const report = await Report.findById(data.reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    report.status = "ACTIONED";
    report.moderatorId = new Types.ObjectId(data.moderatorId);
    report.moderatorNotes = data.moderatorNotes;
    report.actionTaken = data.action;
    await report.save();

    if (data.action === "PROFILE_SUSPENDED" || data.action === "PERMANENT_BAN") {
      await User.findByIdAndUpdate(report.reportedUserId, {
        isSuspended: true,
        suspendedReason: data.moderatorNotes || "Community standards violation",
      });
    }

    await AuditLog.create({
      actorId: new Types.ObjectId(data.moderatorId),
      actorRole: "MODERATOR",
      action: `REPORT_${data.action}`,
      targetCollection: "Report",
      targetId: report._id.toString(),
      details: { action: data.action, notes: data.moderatorNotes },
    });

    return report;
  }
}
