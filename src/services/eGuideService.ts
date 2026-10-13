import { Types } from "mongoose";
import { EGuideContent, EGuideProgress, IEGuideContent } from "../models/EGuide.js";

const DEFAULT_GUIDES: Partial<IEGuideContent>[] = [
  {
    title: "Values Over Checklists: The Marchmaker Approach to Marriage",
    slug: "values-over-checklists",
    category: "VALUES_ALIGNMENT",
    summary: "Why shared vision, conflict resolution styles, and emotional maturity outweigh rigid transactional checklists.",
    bodyMarkdown: `
### Rethinking Compatibility

In contemporary Indian matchmaking, families and individuals often begin with rigid checklists: caste sub-sects, precise salary brackets, or property ownership. While practical considerations matter, longitudinal relationship research consistently demonstrates that marital satisfaction is anchored in three core dimensions:

1. **Shared Long-term Trajectory:** How you envision family life, children, and career balance 10 years into the future.
2. **Conflict Resolution Resilience:** Whether disagreements lead to contempt and stonewalling or constructive vulnerability.
3. **Mutual Respect & Equality:** Respect for each partner's personal autonomy and extended family boundaries.

Before rejecting an introduction based on trivial criteria, ask yourself: *Does this person share my core ethos for living a meaningful life?*
    `.trim(),
    audioUrl: "https://assets.marchmaker.in/audio/values-over-checklists.mp3",
    durationSeconds: 380,
    transcriptText: "Welcome to Marchmaker Audio. Today we explore why emotional maturity and shared values define enduring marriages...",
    order: 1,
    isPublished: true,
  },
  {
    title: "Financial Transparency Before the Wedding",
    slug: "financial-transparency-before-marriage",
    category: "FINANCIAL_HEALTH",
    summary: "A practical framework for having honest, respectful financial conversations with your prospective partner.",
    bodyMarkdown: `
### The Taboo of Money Conversations

Money remains one of the most sensitive topics in Indian matrimonial discussions. Many couples avoid discussing debt, family support expectations, or investment styles until after marriage, leading to preventable stress.

#### Questions to Discuss During Second or Third Conversations:
- How do each of us approach discretionary spending versus long-term saving?
- What are our mutual expectations regarding financial contributions to extended family or aging parents?
- How will joint household expenses, investments, and emergency savings be organized?

True partnership is built on complete transparency and mutual trust.
    `.trim(),
    audioUrl: "https://assets.marchmaker.in/audio/financial-transparency.mp3",
    durationSeconds: 420,
    transcriptText: "In this episode, we break down how to approach financial conversations respectfully and pragmatically...",
    order: 2,
    isPublished: true,
  },
  {
    title: "Navigating Joint vs. Nuclear Family Dynamics",
    slug: "navigating-family-dynamics",
    category: "FAMILY_COMMUNICATION",
    summary: "Constructive strategies for communicating about living arrangements, in-law relationships, and personal boundaries.",
    bodyMarkdown: `
### Balancing Tradition and Personal Space

Indian marriages inherently join two families, not merely two individuals. Navigating relationships with in-laws requires empathy, proactive communication, and clear boundary-setting.

#### Key Principles:
1. **Never Make Assumptions:** Clarify living arrangements, festive traditions, and frequency of family visits beforehand.
2. **United Front:** As a couple, present a united, respectful front in major decisions rather than competing loyalties.
3. **Empathy for Generational Differences:** Recognize that parental expectations often stem from care, while respectfully upholding the autonomy of your new partnership.
    `.trim(),
    audioUrl: "https://assets.marchmaker.in/audio/family-dynamics.mp3",
    durationSeconds: 490,
    transcriptText: "Family harmony is central to Indian matrimonial life. Here is how modern couples establish balance and respect...",
    order: 3,
    isPublished: true,
  },
];

export class EGuideService {
  /**
   * Seed default guides if collection is empty.
   */
  static async seedIfEmpty() {
    const count = await EGuideContent.countDocuments();
    if (count === 0) {
      await EGuideContent.insertMany(DEFAULT_GUIDES);
      console.log("[EGuideService] Seeded default relationship e-guides.");
    }
  }

  static async getAllGuides(userId?: string) {
    await this.seedIfEmpty();
    const guides = await EGuideContent.find({ isPublished: true }).sort({ order: 1 });

    if (!userId) return guides;

    const progressList = await EGuideProgress.find({ userId: new Types.ObjectId(userId) });
    const progressMap = new Map(progressList.map((p) => [p.guideId.toString(), p]));

    return guides.map((g) => {
      const p = progressMap.get(g._id.toString());
      return {
        ...g.toObject(),
        playbackPositionSeconds: p?.playbackPositionSeconds || 0,
        isCompleted: p?.isCompleted || false,
      };
    });
  }

  static async getGuideBySlug(slug: string, userId?: string) {
    const guide = await EGuideContent.findOne({ slug, isPublished: true });
    if (!guide) throw new Error("Guide not found");

    let progress: any = null;
    if (userId) {
      progress = await EGuideProgress.findOne({
        userId: new Types.ObjectId(userId),
        guideId: guide._id,
      });
    }

    return {
      guide,
      progress: {
        playbackPositionSeconds: progress?.playbackPositionSeconds || 0,
        isCompleted: progress?.isCompleted || false,
      },
    };
  }

  static async updateProgress(data: {
    userId: string;
    guideId: string;
    playbackPositionSeconds: number;
    isCompleted?: boolean;
  }) {
    const progress = await EGuideProgress.findOneAndUpdate(
      {
        userId: new Types.ObjectId(data.userId),
        guideId: new Types.ObjectId(data.guideId),
      },
      {
        $set: {
          playbackPositionSeconds: data.playbackPositionSeconds,
          isCompleted: data.isCompleted || false,
          lastListenedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return progress;
  }
}
