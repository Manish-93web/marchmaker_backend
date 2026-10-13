import { Types } from "mongoose";
import { Introduction, IIntroduction, IntroductionStatus } from "../models/Introduction.js";
import { IntroductionEvent } from "../models/IntroductionEvent.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { Notification } from "../models/Notification.js";
import { AuditLog } from "../models/AuditLog.js";
import { User } from "../models/User.js";

export class ReviewService {
  static async getPendingReviews(page = 1, limit = 10, priority?: string) {
    const skip = (page - 1) * limit;
    const filter: any = { status: "PENDING_REVIEW" };
    if (priority) filter.reviewPriority = priority;

    const [introductions, total] = await Promise.all([
      Introduction.find(filter)
        .populate("member1Id", "fullName email")
        .populate("member2Id", "fullName email")
        .sort({ reviewPriority: -1, createdAt: 1 }) // URGENT first, then FIFO
        .skip(skip)
        .limit(limit),
      Introduction.countDocuments(filter),
    ]);

    const enriched = await Promise.all(
      introductions.map(async (intro) => {
        const [p1, p2] = await Promise.all([
          MemberProfile.findOne({ userId: intro.member1Id }).select("-photos"),
          MemberProfile.findOne({ userId: intro.member2Id }).select("-photos"),
        ]);
        return { ...intro.toObject(), profile1: p1, profile2: p2 };
      })
    );

    return { introductions: enriched, total, page, totalPages: Math.ceil(total / limit) };
  }

  static async reviewIntroduction(data: {
    introductionId: string;
    reviewerId: string;
    decision: "APPROVE" | "REJECT";
    notes?: string;
    declineReason?: string;
  }): Promise<IIntroduction> {
    const intro = await Introduction.findById(data.introductionId);
    if (!intro) throw new Error("Introduction not found");
    if (intro.status !== "PENDING_REVIEW") {
      throw new Error(`Cannot review introduction in ${intro.status} state`);
    }

    const fromState = intro.status;
    const toState: IntroductionStatus = data.decision === "APPROVE" ? "OFFERED" : "REJECTED_BY_REVIEWER";

    intro.status = toState;
    intro.reviewerId = new Types.ObjectId(data.reviewerId);
    intro.reviewerNotes = data.notes;
    if (data.decision === "REJECT") intro.reviewDeclineReason = data.declineReason;

    // Generate explainable highlights at approval time if not already set
    if (toState === "OFFERED" && intro.explainableHighlights.length === 0) {
      intro.explainableHighlights = await ReviewService._generateHighlights(
        intro.member1Id.toString(),
        intro.member2Id.toString()
      );
      intro.offeredAt = new Date();
      intro.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    await intro.save();

    await IntroductionEvent.create({
      introductionId: intro._id,
      fromState,
      toState,
      actorId: new Types.ObjectId(data.reviewerId),
      actorRole: "REVIEWER",
      reason: data.notes || data.declineReason,
    });

    await AuditLog.create({
      actorId: new Types.ObjectId(data.reviewerId),
      actorRole: "REVIEWER",
      action: `INTRODUCTION_${data.decision}`,
      targetCollection: "Introduction",
      targetId: intro._id.toString(),
      details: { decision: data.decision, notes: data.notes, declineReason: data.declineReason },
    });

    if (toState === "OFFERED") {
      const highlights = intro.explainableHighlights;
      const summaryLine = highlights.length > 0
        ? `Key alignment: ${highlights.slice(0, 2).join("; ")}.`
        : "Our team identified strong compatibility across multiple dimensions.";

      await Promise.all([
        Notification.create({
          userId: intro.member1Id,
          title: "A New Hand-Reviewed Introduction Is Ready 💍",
          message: `Our matchmaking team has curated a compatible introduction. ${summaryLine} Review the card now.`,
          category: "INTRODUCTION",
          deepLink: "/dashboard/introductions",
        }),
        Notification.create({
          userId: intro.member2Id,
          title: "A New Hand-Reviewed Introduction Is Ready 💍",
          message: `Our matchmaking team has curated a compatible introduction. ${summaryLine} Review the card now.`,
          category: "INTRODUCTION",
          deepLink: "/dashboard/introductions",
        }),
      ]);

      try {
        const { EmailService } = await import("./emailService.js");
        const [u1, u2] = await Promise.all([
          User.findById(intro.member1Id),
          User.findById(intro.member2Id),
        ]);
        if (u1) await EmailService.sendIntroductionOfferedEmail(u1.email, u1.fullName, intro._id.toString());
        if (u2) await EmailService.sendIntroductionOfferedEmail(u2.email, u2.fullName, intro._id.toString());
      } catch (e) {
        console.warn("[ReviewService] Email dispatch warning:", e);
      }
    }

    return intro;
  }

  /**
   * Escalate a review for senior attention (suspicious profile, complex case, etc.)
   */
  static async escalateReview(data: {
    introductionId: string;
    escalatedByReviewerId: string;
    reason: string;
  }): Promise<IIntroduction> {
    const intro = await Introduction.findById(data.introductionId);
    if (!intro) throw new Error("Introduction not found");

    intro.isEscalated = true;
    intro.escalationReason = data.reason;
    intro.escalatedAt = new Date();
    intro.reviewPriority = "URGENT";
    await intro.save();

    await AuditLog.create({
      actorId: new Types.ObjectId(data.escalatedByReviewerId),
      actorRole: "REVIEWER",
      action: "INTRODUCTION_ESCALATED",
      targetCollection: "Introduction",
      targetId: intro._id.toString(),
      details: { reason: data.reason },
    });

    return intro;
  }

  /**
   * Set review priority for queue management.
   */
  static async setPriority(introductionId: string, priority: "NORMAL" | "HIGH" | "URGENT"): Promise<void> {
    await Introduction.findByIdAndUpdate(introductionId, { reviewPriority: priority });
  }

  /**
   * Reviewer workload statistics — per-reviewer pending and completed counts.
   */
  static async getReviewerStats() {
    const [pendingCount, escalatedCount, todayApproved, todayRejected, workloadByReviewer] = await Promise.all([
      Introduction.countDocuments({ status: "PENDING_REVIEW" }),
      Introduction.countDocuments({ status: "PENDING_REVIEW", isEscalated: true }),

      Introduction.countDocuments({
        status: "OFFERED",
        updatedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      Introduction.countDocuments({
        status: "REJECTED_BY_REVIEWER",
        updatedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),

      Introduction.aggregate([
        { $match: { reviewerId: { $exists: true, $ne: null }, status: { $in: ["OFFERED", "REJECTED_BY_REVIEWER"] } } },
        { $group: { _id: "$reviewerId", reviewed: { $sum: 1 }, approved: { $sum: { $cond: [{ $eq: ["$status", "OFFERED"] }, 1, 0] } } } },
        { $sort: { reviewed: -1 } },
        { $limit: 10 },
      ]),
    ]);

    // Populate reviewer names
    const enrichedWorkload = await Promise.all(
      workloadByReviewer.map(async (w) => {
        const reviewer = await User.findById(w._id).select("fullName email");
        return {
          reviewerId: w._id.toString(),
          reviewerName: reviewer?.fullName || "Unknown",
          reviewerEmail: reviewer?.email || "",
          totalReviewed: w.reviewed,
          approved: w.approved,
          rejected: w.reviewed - w.approved,
          approvalRate: w.reviewed > 0 ? Math.round((w.approved / w.reviewed) * 100) : 0,
        };
      })
    );

    return {
      queueSummary: {
        pendingReview: pendingCount,
        escalated: escalatedCount,
        approvedToday: todayApproved,
        rejectedToday: todayRejected,
      },
      reviewerWorkload: enrichedWorkload,
    };
  }

  /**
   * Generate explainable highlights by comparing the two member profiles and preferences.
   * Returns natural-language alignment bullets; no numeric score exposed to members.
   */
  static async _generateHighlights(member1Id: string, member2Id: string): Promise<string[]> {
    const [p1, p2] = await Promise.all([
      MemberProfile.findOne({ userId: member1Id }),
      MemberProfile.findOne({ userId: member2Id }),
    ]);
    if (!p1 || !p2) return [];

    const highlights: string[] = [];

    // City match
    if (p1.city && p1.city === p2.city) {
      highlights.push(`Both currently based in ${p1.city}`);
    } else if (p1.state && p1.state === p2.state) {
      highlights.push(`Both based in ${p1.state}`);
    }

    // Diet alignment
    if (p1.diet && p1.diet === p2.diet) {
      const dietLabel = p1.diet.charAt(0) + p1.diet.slice(1).toLowerCase();
      highlights.push(`Aligned dietary preferences (${dietLabel})`);
    }

    // Family values
    if (p1.familyValues && p1.familyValues === p2.familyValues) {
      highlights.push(`Shared family values (${p1.familyValues.toLowerCase()})`);
    }

    // Family type
    if (p1.familyType && p1.familyType === p2.familyType) {
      highlights.push(`Similar family backgrounds (${p1.familyType.toLowerCase()} family)`);
    }

    // Education level similarity
    if (p1.educationLevel && p2.educationLevel) {
      highlights.push("Comparable educational backgrounds");
    }

    // Religion alignment (if both provided)
    if (p1.religion && p1.religion === p2.religion) {
      highlights.push(`Same religious background (${p1.religion})`);
    }

    // Check draft data for marriage timeline and interests
    const d1 = p1.draftData || {};
    const d2 = p2.draftData || {};
    if (d1.marriageTimeline && d1.marriageTimeline === d2.marriageTimeline) {
      highlights.push(`Shared marriage timeline: ${d1.marriageTimeline}`);
    }
    const sharedInterests = (d1.interests || []).filter((i: string) =>
      (d2.interests || []).map((x: string) => x.toLowerCase()).includes(i.toLowerCase())
    );
    if (sharedInterests.length > 0) {
      highlights.push(`Shared interests: ${sharedInterests.slice(0, 2).join(", ")}`);
    }

    return highlights.slice(0, 5);
  }
}
