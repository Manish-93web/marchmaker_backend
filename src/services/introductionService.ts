import { Types } from "mongoose";
import { Introduction, IIntroduction, IntroductionStatus } from "../models/Introduction.js";
import { IntroductionEvent } from "../models/IntroductionEvent.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { IntroductionFeedback } from "../models/IntroductionFeedback.js";

export class IntroductionService {
  static async getIntroductionsForMember(userId: string) {
    const intros = await Introduction.find({
      $or: [{ member1Id: userId }, { member2Id: userId }],
      status: { $in: ["OFFERED", "PAYMENT_PENDING", "UNLOCKED", "ACCEPTED", "DECLINED", "COMPLETED"] },
    }).sort({ createdAt: -1 });

    const formatted = await Promise.all(
      intros.map(async (intro) => {
        const isMember1 = intro.member1Id.toString() === userId;
        const candidateId = isMember1 ? intro.member2Id : intro.member1Id;
        const myDecision = isMember1 ? intro.member1Decision : intro.member2Decision;
        const candidateDecision = isMember1 ? intro.member2Decision : intro.member1Decision;
        const isUnlockedByMe = isMember1 ? intro.member1Unlocked : intro.member2Unlocked;

        const candidateUser = await User.findById(candidateId).select("fullName email phone");
        const candidateProfile = await MemberProfile.findOne({ userId: candidateId });

        // Privacy projection: if not unlocked, mask full name and contact info
        let displayCandidate: any = null;
        if (candidateProfile) {
          const profileObj = candidateProfile.toObject();
          if (!isUnlockedByMe) {
            // Mask sensitive fields
            const names = profileObj.fullName.split(" ");
            const firstName = names[0] || "Candidate";
            const initial = names.length > 1 ? ` ${names[1][0]}.` : "";
            profileObj.fullName = `${firstName}${initial}`;
            // Filter out private photos if not unlocked
            profileObj.photos = profileObj.photos.filter((p: any) => !p.isPrivate);
          }
          displayCandidate = {
            ...profileObj,
            email: isUnlockedByMe ? candidateUser?.email : undefined,
            phone: isUnlockedByMe ? candidateUser?.phone : undefined,
          };
        }

        return {
          _id: intro._id,
          status: intro.status,
          compatibilityScore: intro.compatibilityScore,
          explainableHighlights: intro.explainableHighlights,
          myDecision,
          candidateDecision,
          isUnlockedByMe,
          bothAccepted: intro.member1Decision === "ACCEPTED" && intro.member2Decision === "ACCEPTED",
          candidate: displayCandidate,
          notesExchange: intro.notesExchange,
          offeredAt: intro.offeredAt,
          expiresAt: intro.expiresAt,
        };
      })
    );

    return formatted;
  }

  static async respondToIntroduction(data: {
    introductionId: string;
    userId: string;
    decision: "ACCEPTED" | "DECLINED";
    declineReason?: string;
  }): Promise<IIntroduction> {
    const intro = await Introduction.findById(data.introductionId);
    if (!intro) {
      throw new Error("Introduction not found");
    }

    const isMember1 = intro.member1Id.toString() === data.userId;
    const isMember2 = intro.member2Id.toString() === data.userId;
    if (!isMember1 && !isMember2) {
      throw new Error("Unauthorized to respond to this introduction");
    }

    const fromState = intro.status;
    if (isMember1) {
      intro.member1Decision = data.decision;
      if (data.decision === "DECLINED") intro.member1DeclineReason = data.declineReason;
    } else {
      intro.member2Decision = data.decision;
      if (data.decision === "DECLINED") intro.member2DeclineReason = data.declineReason;
    }

    // Evaluate state transition
    if (intro.member1Decision === "ACCEPTED" && intro.member2Decision === "ACCEPTED") {
      intro.status = "ACCEPTED";
      intro.completedAt = new Date();

      // Notify both parties of mutual match!
      await Promise.all([
        Notification.create({
          userId: intro.member1Id,
          title: "It's a Mutual Match! 🎉",
          message: "Both of you accepted the introduction! You can now exchange direct notes and coordinate next steps.",
          category: "INTRODUCTION",
          deepLink: "/dashboard/introductions",
        }),
        Notification.create({
          userId: intro.member2Id,
          title: "It's a Mutual Match! 🎉",
          message: "Both of you accepted the introduction! You can now exchange direct notes and coordinate next steps.",
          category: "INTRODUCTION",
          deepLink: "/dashboard/introductions",
        }),
      ]);
    } else if (intro.member1Decision === "DECLINED" || intro.member2Decision === "DECLINED") {
      intro.status = "DECLINED";
    }

    await intro.save();

    await IntroductionEvent.create({
      introductionId: intro._id,
      fromState,
      toState: intro.status,
      actorId: new Types.ObjectId(data.userId),
      actorRole: "MEMBER",
      reason: data.declineReason || `Member responded ${data.decision}`,
    });

    return intro;
  }

  static async sendNote(data: {
    introductionId: string;
    userId: string;
    content: string;
  }): Promise<IIntroduction> {
    const intro = await Introduction.findById(data.introductionId);
    if (!intro) {
      throw new Error("Introduction not found");
    }

    const isMember1 = intro.member1Id.toString() === data.userId;
    const isMember2 = intro.member2Id.toString() === data.userId;
    if (!isMember1 && !isMember2) {
      throw new Error("Unauthorized");
    }

    const isUnlocked = isMember1 ? intro.member1Unlocked : intro.member2Unlocked;
    if (!isUnlocked) {
      throw new Error("Please unlock this introduction before exchanging introductory notes.");
    }

    intro.notesExchange.push({
      senderId: new Types.ObjectId(data.userId),
      content: data.content,
      sentAt: new Date(),
    });

    await intro.save();

    const recipientId = isMember1 ? intro.member2Id : intro.member1Id;
    await Notification.create({
      userId: recipientId,
      title: "New Note Received 💌",
      message: "You have received an introductory note regarding your recent introduction.",
      category: "INTRODUCTION",
      deepLink: "/dashboard/introductions",
    });

    return intro;
  }

  static async submitFeedback(data: {
    introductionId: string;
    userId: string;
    candidateId: string;
    relevanceRating: number;
    expectationsMet: "YES" | "PARTIALLY" | "NO";
    communicationFeedback?: string;
    feedbackNotes?: string;
  }) {
    const feedback = await IntroductionFeedback.findOneAndUpdate(
      { introductionId: data.introductionId, userId: data.userId },
      {
        $set: {
          candidateId: new Types.ObjectId(data.candidateId),
          relevanceRating: data.relevanceRating,
          expectationsMet: data.expectationsMet,
          communicationFeedback: data.communicationFeedback,
          feedbackNotes: data.feedbackNotes,
        },
      },
      { new: true, upsert: true }
    );
    return feedback;
  }
}
