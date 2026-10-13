import { Types } from "mongoose";
import { User } from "../models/User.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { PartnerPreferences } from "../models/PartnerPreferences.js";
import { Assessment } from "../models/Assessment.js";
import { Introduction } from "../models/Introduction.js";
import { Payment } from "../models/Payment.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { DataDeletionRequest } from "../models/ConsentRecord.js";

export class PrivacyService {
  static async exportUserData(userId: string) {
    const [user, profile, preferences, assessment, introductions, payments] =
      await Promise.all([
        User.findById(userId).select("-passwordHash"),
        MemberProfile.findOne({ userId }),
        PartnerPreferences.findOne({ userId }),
        Assessment.findOne({ userId }),
        Introduction.find({ $or: [{ member1Id: userId }, { member2Id: userId }] }),
        Payment.find({ userId }).select("-razorpaySignature"),
      ]);

    return {
      exportGeneratedAt: new Date(),
      complianceStandard: "India Digital Personal Data Protection Act 2023 (DPDP Act)",
      user,
      profile,
      preferences,
      assessment,
      introductionsCount: introductions.length,
      paymentsCount: payments.length,
    };
  }

  static async requestDataDeletion(userId: string, reason?: string) {
    const existing = await DataDeletionRequest.findOne({
      userId,
      status: { $in: ["PENDING", "PROCESSING"] },
    });
    if (existing) {
      return existing;
    }

    const request = await DataDeletionRequest.create({
      userId: new Types.ObjectId(userId),
      reason,
      status: "PENDING",
      requestedAt: new Date(),
      scheduledDeletionDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day grace period
    });

    return request;
  }

  static async recordConsent(data: {
    userId: string;
    termsAccepted: boolean;
    privacyPolicyAccepted: boolean;
    dpdpConsentAccepted: boolean;
    matchmakingConsentAccepted: boolean;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return ConsentRecord.create({
      userId: new Types.ObjectId(data.userId),
      termsAccepted: data.termsAccepted,
      privacyPolicyAccepted: data.privacyPolicyAccepted,
      dpdpConsentAccepted: data.dpdpConsentAccepted,
      matchmakingConsentAccepted: data.matchmakingConsentAccepted,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      version: "1.0.0",
      consentedAt: new Date(),
    });
  }
}
