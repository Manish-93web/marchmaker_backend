import { User } from "../models/User.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { VerificationRequest } from "../models/VerificationRequest.js";
import { Introduction } from "../models/Introduction.js";
import { Payment } from "../models/Payment.js";
import { AuditLog } from "../models/AuditLog.js";

export class AdminService {
  static async getPlatformStats() {
    const [
      totalMembers,
      verifiedCount,
      pendingVerifications,
      pendingReviews,
      offeredIntroductions,
      mutualMatches,
      paymentsSummary,
    ] = await Promise.all([
      User.countDocuments({ role: "MEMBER" }),
      VerificationRequest.countDocuments({ status: "APPROVED" }),
      VerificationRequest.countDocuments({ status: "PENDING" }),
      Introduction.countDocuments({ status: "PENDING_REVIEW" }),
      Introduction.countDocuments({ status: "OFFERED" }),
      Introduction.countDocuments({ status: "ACCEPTED" }),
      Payment.aggregate([
        { $match: { status: "CAPTURED" } },
        { $group: { _id: null, totalRevenueINR: { $sum: "$amountINR" }, count: { $sum: 1 } } },
      ]),
    ]);

    const totalRevenueINR = paymentsSummary[0]?.totalRevenueINR || 0;
    const paidTransactions = paymentsSummary[0]?.count || 0;

    return {
      totalMembers,
      verifiedMembers: verifiedCount,
      pendingVerifications,
      pendingReviews,
      offeredIntroductions,
      mutualMatches,
      totalRevenueINR,
      paidTransactions,
      funnel: {
        registered: totalMembers,
        kycApproved: verifiedCount,
        handReviewed: pendingReviews + offeredIntroductions + mutualMatches,
        mutualAccepted: mutualMatches,
      },
    };
  }

  static async listMembers(query: {
    page?: number;
    limit?: number;
    search?: string;
    isSuspended?: boolean;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const filter: any = { role: "MEMBER" };
    if (query.isSuspended !== undefined) {
      filter.isSuspended = query.isSuspended;
    }
    if (query.search) {
      filter.$or = [
        { fullName: { $regex: query.search, $options: "i" } },
        { email: { $regex: query.search, $options: "i" } },
      ];
    }

    const [members, total] = await Promise.all([
      User.find(filter).select("-passwordHash").sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    // Attach basic profile info
    const enriched = await Promise.all(
      members.map(async (m) => {
        const profile = await MemberProfile.findOne({ userId: m._id }).select(
          "completionPercentage isProfileSubmitted city state occupationTitle photos"
        );
        return {
          ...m.toObject(),
          profile,
        };
      })
    );

    return { members: enriched, total, page, totalPages: Math.ceil(total / limit) };
  }

  static async getAuditLogs(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      AuditLog.find()
        .populate("actorId", "fullName email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(),
    ]);

    return { logs, total, page, totalPages: Math.ceil(total / limit) };
  }
}
