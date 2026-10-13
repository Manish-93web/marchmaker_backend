import { Types } from "mongoose";
import { User } from "../models/User.js";
import { MemberProfile, IMemberProfile } from "../models/MemberProfile.js";
import { PartnerPreferences, IPartnerPreferences } from "../models/PartnerPreferences.js";
import { Assessment, IAssessment } from "../models/Assessment.js";
import { Introduction, IIntroduction } from "../models/Introduction.js";
import { BlockedUser } from "../models/Report.js";
import { VerificationRequest } from "../models/VerificationRequest.js";
import { AssessmentService } from "./assessmentService.js";

export class MatchingService {
  /**
   * Evaluates match eligibility and generates a candidate pair for human review
   */
  static async findAndQueueMatches(memberId: string): Promise<IIntroduction | null> {
    const user = await User.findById(memberId);
    if (!user || user.isSuspended) return null;

    const userProfile = await MemberProfile.findOne({ userId: memberId });
    if (!userProfile || !userProfile.isProfileSubmitted) return null;

    const userPrefs = await PartnerPreferences.findOne({ userId: memberId });
    const userAssessment = await Assessment.findOne({ userId: memberId });

    // Target opposite gender (or complementary)
    const targetGender = userProfile.gender === "MALE" ? "FEMALE" : "MALE";

    // Blocked users
    const blockedRecords = await BlockedUser.find({
      $or: [{ userId: memberId }, { blockedUserId: memberId }],
    });
    const blockedIds = blockedRecords.map((b) =>
      b.userId.toString() === memberId ? b.blockedUserId.toString() : b.userId.toString()
    );

    // Existing introductions
    const existingIntros = await Introduction.find({
      $or: [{ member1Id: memberId }, { member2Id: memberId }],
    });
    const alreadyIntroducedIds = existingIntros.map((i) =>
      i.member1Id.toString() === memberId ? i.member2Id.toString() : i.member1Id.toString()
    );

    const excludeIds = [memberId, ...blockedIds, ...alreadyIntroducedIds].map(
      (id) => new Types.ObjectId(id)
    );

    // Build candidate query
    const candidateQuery: any = {
      userId: { $nin: excludeIds },
      gender: targetGender,
      isProfileSubmitted: true,
    };

    // Apply hard constraints if configured
    if (userPrefs) {
      if (userPrefs.hardConstraints?.religion && userPrefs.religions?.length) {
        candidateQuery.religion = { $in: userPrefs.religions };
      }
      if (userPrefs.hardConstraints?.maritalStatus && userPrefs.maritalStatuses?.length) {
        candidateQuery.maritalStatus = { $in: userPrefs.maritalStatuses };
      }
    }

    const potentialCandidates = await MemberProfile.find(candidateQuery).limit(20);
    if (!potentialCandidates || potentialCandidates.length === 0) {
      return null;
    }

    // Rank candidates by compatibility and age constraints
    let bestCandidate: IMemberProfile | null = null;
    let highestScore = -1;
    let bestHighlights: string[] = [];

    const userAge = userProfile.dateOfBirth
      ? Math.floor((Date.now() - new Date(userProfile.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : 28;

    for (const cand of potentialCandidates) {
      const candAssessment = await Assessment.findOne({ userId: cand.userId });
      const { score, highlights } = AssessmentService.generateExplainableCompatibility(
        userAssessment,
        candAssessment
      );

      // Soft age score penalty
      let finalScore = score;
      if (cand.dateOfBirth && userPrefs) {
        const candAge = Math.floor(
          (Date.now() - new Date(cand.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
        );
        if (candAge < userPrefs.ageMin || candAge > userPrefs.ageMax) {
          finalScore -= 15;
        }
      }

      if (finalScore > highestScore) {
        highestScore = finalScore;
        bestCandidate = cand;
        bestHighlights = highlights;
      }
    }

    if (!bestCandidate) return null;

    // Check duplicate introduction check before inserting
    const existing = await Introduction.findOne({
      $or: [
        { member1Id: memberId, member2Id: bestCandidate.userId },
        { member1Id: bestCandidate.userId, member2Id: memberId },
      ],
    });

    if (existing) return existing;

    // Create Introduction in PENDING_REVIEW state for human reviewer
    const intro = await Introduction.create({
      member1Id: new Types.ObjectId(memberId),
      member2Id: bestCandidate.userId,
      status: "PENDING_REVIEW",
      compatibilityScore: highestScore,
      explainableHighlights: bestHighlights,
      reviewerNotes: "System suggested match meeting mutual preferences and compatibility threshold.",
    });

    return intro;
  }
}
