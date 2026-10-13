import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { VerificationRequest } from "../models/VerificationRequest.js";
import { Introduction } from "../models/Introduction.js";
import { TrustService } from "../services/trustService.js";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const user = req.user!;

    const [profile, verification, introductions] = await Promise.all([
      MemberProfile.findOne({ userId }),
      VerificationRequest.findOne({ userId }).sort({ createdAt: -1 }),
      Introduction.find({ $or: [{ member1Id: userId }, { member2Id: userId }] }),
    ]);

    // Determine current journey stage
    // Stages:
    // 1. ACCOUNT_CREATED (Done)
    // 2. EMAIL_VERIFIED
    // 3. PROFILE_IN_PROGRESS
    // 4. PROFILE_SUBMITTED
    // 5. VERIFICATION_PENDING / VERIFIED
    // 6. ELIGIBLE_FOR_MATCHING
    // 7. INTRODUCTION_OFFERED
    // 8. PAYMENT_UNLOCKED
    // 9. MUTUAL_MATCH

    let currentStage = "ACCOUNT_CREATED";
    let nextActionTitle = "Complete Profile Basics";
    let nextActionLink = "/onboarding";
    let isPendingTeamAction = false;

    if (user.isEmailVerified) {
      currentStage = "EMAIL_VERIFIED";
    }

    if (profile) {
      if (!profile.isProfileSubmitted) {
        currentStage = "PROFILE_IN_PROGRESS";
        nextActionTitle = "Complete Guided Profile";
        nextActionLink = "/onboarding";
      } else {
        currentStage = "PROFILE_SUBMITTED";
        nextActionTitle = "Submit Government ID & Selfie";
        nextActionLink = "/dashboard/verification";
      }
    }

    if (verification) {
      if (verification.status === "PENDING") {
        currentStage = "VERIFICATION_PENDING";
        isPendingTeamAction = true;
        nextActionTitle = "Awaiting Verification Review";
        nextActionLink = "/dashboard/verification";
      } else if (verification.status === "APPROVED") {
        currentStage = "ELIGIBLE_FOR_MATCHING";
        nextActionTitle = "Matching in Progress";
        nextActionLink = "/dashboard/introductions";
      } else if (verification.status === "ACTION_REQUIRED" || verification.status === "REJECTED") {
        currentStage = "VERIFICATION_ACTION_REQUIRED";
        nextActionTitle = "Resubmit Verification Documents";
        nextActionLink = "/dashboard/verification";
      }
    }

    // Check introductions
    const activeOffer = introductions.find((i) => i.status === "OFFERED" || i.status === "UNLOCKED" || i.status === "ACCEPTED");
    if (activeOffer) {
      const isMember1 = activeOffer.member1Id.toString() === userId;
      const isUnlocked = isMember1 ? activeOffer.member1Unlocked : activeOffer.member2Unlocked;
      if (activeOffer.status === "ACCEPTED") {
        currentStage = "MUTUAL_MATCH";
        nextActionTitle = "Mutual Match Accepted! Exchange Notes";
        nextActionLink = "/dashboard/introductions";
      } else if (isUnlocked) {
        currentStage = "PAYMENT_UNLOCKED";
        nextActionTitle = "View Full Match Profile & Respond";
        nextActionLink = "/dashboard/introductions";
      } else {
        currentStage = "INTRODUCTION_OFFERED";
        nextActionTitle = "Review Hand-Curated Introduction";
        nextActionLink = "/dashboard/introductions";
      }
    }

    res.json({
      success: true,
      data: {
        currentStage,
        nextActionTitle,
        nextActionLink,
        isPendingTeamAction,
        stages: [
          { key: "ACCOUNT_CREATED", label: "Account Created", completed: true },
          { key: "EMAIL_VERIFIED", label: "Email Verified", completed: user.isEmailVerified },
          { key: "PROFILE_SUBMITTED", label: "Profile Submitted", completed: Boolean(profile?.isProfileSubmitted) },
          { key: "VERIFICATION_APPROVED", label: "KYC Verified", completed: verification?.status === "APPROVED" },
          { key: "ELIGIBLE_FOR_MATCHING", label: "Matching Queue", completed: verification?.status === "APPROVED" },
          { key: "INTRODUCTION_OFFERED", label: "Hand-Picked Match", completed: Boolean(activeOffer) },
          { key: "MUTUAL_MATCH", label: "Mutual Connection", completed: activeOffer?.status === "ACCEPTED" },
        ],
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Trust verification status dashboard — no document URLs exposed
router.get("/trust-status", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = await TrustService.getTrustStatus(req.userId!);
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
