import { IntroductionFeedback } from "../models/IntroductionFeedback.js";
import { Introduction } from "../models/Introduction.js";

export interface FeedbackAnalytics {
  totalFeedback: number;
  averageRelevanceRating: number;
  expectationsMetBreakdown: { YES: number; PARTIALLY: number; NO: number };
  ratingDistribution: { rating: number; count: number }[];
  lowRatedIntroductions: Array<{
    introductionId: string;
    averageRating: number;
    feedbackCount: number;
    expectationsMet: string;
  }>;
  matchQualityTrend: Array<{ month: string; avgRating: number; total: number }>;
}

export class FeedbackService {
  /**
   * Aggregate feedback analytics for admin/reviewer quality review.
   * Used to measure match quality, not just volume.
   */
  static async getAnalytics(daysBack = 90): Promise<FeedbackAnalytics> {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const [totalFeedback, ratingAgg, expectationsAgg, ratingDist, lowRated, trend] = await Promise.all([
      IntroductionFeedback.countDocuments({ createdAt: { $gte: since } }),

      IntroductionFeedback.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, avg: { $avg: "$relevanceRating" } } },
      ]),

      IntroductionFeedback.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$expectationsMet", count: { $sum: 1 } } },
      ]),

      IntroductionFeedback.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$relevanceRating", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // Introductions that averaged below 3 stars — flag for reviewer quality review
      IntroductionFeedback.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$introductionId",
            averageRating: { $avg: "$relevanceRating" },
            feedbackCount: { $sum: 1 },
            expectationsMet: { $first: "$expectationsMet" },
          },
        },
        { $match: { averageRating: { $lt: 3 } } },
        { $sort: { averageRating: 1 } },
        { $limit: 10 },
      ]),

      // Month-by-month quality trend
      IntroductionFeedback.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            avgRating: { $avg: "$relevanceRating" },
            total: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    const expectationsMap: Record<string, number> = { YES: 0, PARTIALLY: 0, NO: 0 };
    for (const e of expectationsAgg) {
      if (e._id in expectationsMap) expectationsMap[e._id] = e.count;
    }

    return {
      totalFeedback,
      averageRelevanceRating: Number((ratingAgg[0]?.avg || 0).toFixed(2)),
      expectationsMetBreakdown: {
        YES: expectationsMap["YES"],
        PARTIALLY: expectationsMap["PARTIALLY"],
        NO: expectationsMap["NO"],
      },
      ratingDistribution: ratingDist.map((r) => ({ rating: r._id, count: r.count })),
      lowRatedIntroductions: lowRated.map((l) => ({
        introductionId: l._id.toString(),
        averageRating: Number(l.averageRating.toFixed(2)),
        feedbackCount: l.feedbackCount,
        expectationsMet: l.expectationsMet,
      })),
      matchQualityTrend: trend.map((t) => ({
        month: `${t._id.year}-${String(t._id.month).padStart(2, "0")}`,
        avgRating: Number(t.avgRating.toFixed(2)),
        total: t.total,
      })),
    };
  }

  /**
   * Get flagged (low-rated) introductions that need reviewer attention.
   */
  static async getFlaggedIntroductionIds(): Promise<string[]> {
    const result = await IntroductionFeedback.aggregate([
      { $group: { _id: "$introductionId", avg: { $avg: "$relevanceRating" } } },
      { $match: { avg: { $lt: 2.5 } } },
    ]);
    return result.map((r) => r._id.toString());
  }
}
