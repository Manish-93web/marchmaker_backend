import { User } from "../models/User.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { VerificationRequest } from "../models/VerificationRequest.js";

export interface TrustItem {
  key: string;
  label: string;
  status: "COMPLETE" | "PENDING" | "ACTION_REQUIRED" | "NOT_STARTED";
  detail: string;
  actionLabel?: string;
  actionLink?: string;
}

export interface TrustStatus {
  overallLevel: "UNVERIFIED" | "PARTIAL" | "VERIFIED" | "TRUSTED";
  completionPercent: number;
  items: TrustItem[];
  nextAction?: { label: string; link: string };
}

export class TrustService {
  /**
   * Returns a structured trust checklist for a member.
   * Never exposes document URLs, only status strings.
   */
  static async getTrustStatus(userId: string): Promise<TrustStatus> {
    const [user, profile, verification] = await Promise.all([
      User.findById(userId).select("isEmailVerified phone isSuspended createdAt"),
      MemberProfile.findOne({ userId }).select("isProfileSubmitted completionPercentage photos city state bio"),
      VerificationRequest.findOne({ userId }).sort({ createdAt: -1 }).select("status documentType reviewedAt"),
    ]);

    if (!user) throw new Error("User not found");

    const items: TrustItem[] = [];
    let completedCount = 0;
    const totalItems = 5;

    // 1. Email verification
    if (user.isEmailVerified) {
      items.push({ key: "email", label: "Email Address", status: "COMPLETE", detail: "Your email address has been verified." });
      completedCount++;
    } else {
      items.push({ key: "email", label: "Email Address", status: "ACTION_REQUIRED", detail: "Please verify your email address to secure your account.", actionLabel: "Verify Email", actionLink: "/dashboard/settings" });
    }

    // 2. Profile completeness
    if (profile?.isProfileSubmitted) {
      items.push({ key: "profile", label: "Member Profile", status: "PENDING", detail: "Your profile has been submitted and is under review by our team." });
      completedCount += 0.75;
    } else if (profile?.bio) {
      items.push({ key: "profile", label: "Member Profile", status: "ACTION_REQUIRED", detail: "Your profile is a draft. Complete and submit it to be considered for introductions.", actionLabel: "Complete Profile", actionLink: "/dashboard/profile" });
      completedCount += 0.25;
    } else {
      items.push({ key: "profile", label: "Member Profile", status: "NOT_STARTED", detail: "Start your profile to begin the matching process.", actionLabel: "Start Profile", actionLink: "/dashboard/profile" });
    }

    // 3. Identity verification (KYC) — never expose document URLs
    if (verification?.status === "APPROVED") {
      items.push({ key: "kyc", label: "Identity Verification", status: "COMPLETE", detail: `Identity verified via ${(verification as any).documentType || "government document"}.` });
      completedCount++;
    } else if (verification?.status === "PENDING") {
      items.push({ key: "kyc", label: "Identity Verification", status: "PENDING", detail: "Your identity documents are under review. This typically takes 1–2 business days." });
      completedCount += 0.5;
    } else if (verification?.status === "ACTION_REQUIRED") {
      items.push({ key: "kyc", label: "Identity Verification", status: "ACTION_REQUIRED", detail: "Our verification team has requested additional information. Please check your notifications.", actionLabel: "View Request", actionLink: "/dashboard/verification" });
    } else if (verification?.status === "REJECTED") {
      items.push({ key: "kyc", label: "Identity Verification", status: "ACTION_REQUIRED", detail: "Your verification was not approved. Please resubmit your documents.", actionLabel: "Resubmit Documents", actionLink: "/dashboard/verification" });
    } else {
      items.push({ key: "kyc", label: "Identity Verification", status: "NOT_STARTED", detail: "Submit a government-issued identity document to become a verified member.", actionLabel: "Start Verification", actionLink: "/dashboard/verification" });
    }

    // 4. Profile photograph
    const hasPhoto = (profile?.photos?.length ?? 0) > 0;
    if (hasPhoto) {
      items.push({ key: "photo", label: "Profile Photograph", status: "COMPLETE", detail: "At least one photograph has been added to your profile." });
      completedCount++;
    } else {
      items.push({ key: "photo", label: "Profile Photograph", status: "ACTION_REQUIRED", detail: "Add a clear photograph to your profile. Profiles with photographs receive significantly more introductions.", actionLabel: "Add Photo", actionLink: "/dashboard/photos" });
    }

    // 5. Profile completion percentage as proxy for assessment readiness
    const completionPct = profile?.completionPercentage ?? 0;
    if (completionPct >= 80) {
      items.push({ key: "assessment", label: "Compatibility Assessment", status: "COMPLETE", detail: "Your compatibility assessment is complete and active." });
      completedCount++;
    } else if (completionPct >= 40) {
      items.push({ key: "assessment", label: "Compatibility Assessment", status: "ACTION_REQUIRED", detail: `Profile is ${completionPct}% complete. Finish the compatibility questionnaire to be matched.`, actionLabel: "Continue Assessment", actionLink: "/dashboard/assessment" });
    } else {
      items.push({ key: "assessment", label: "Compatibility Assessment", status: "NOT_STARTED", detail: "Complete the compatibility questionnaire so our team can propose relevant introductions.", actionLabel: "Start Assessment", actionLink: "/dashboard/assessment" });
    }

    const completionPercent = Math.round((completedCount / totalItems) * 100);

    let overallLevel: TrustStatus["overallLevel"] = "UNVERIFIED";
    if (completionPercent >= 100) overallLevel = "TRUSTED";
    else if (completionPercent >= 70) overallLevel = "VERIFIED";
    else if (completionPercent >= 30) overallLevel = "PARTIAL";

    // Determine top priority next action
    const nextItem = items.find((i) => i.status === "ACTION_REQUIRED" || i.status === "NOT_STARTED");
    const nextAction = nextItem?.actionLabel ? { label: nextItem.actionLabel, link: nextItem.actionLink! } : undefined;

    return { overallLevel, completionPercent, items, nextAction };
  }
}
