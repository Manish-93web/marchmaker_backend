import { Assessment, IAssessment, IAssessmentAnswer } from "../models/Assessment.js";

export const QUESTIONNAIRE_V1 = [
  {
    id: "VAL_01",
    dimension: "VALUES",
    questionText: "How do you approach traditional cultural rituals vs modern personal choices?",
    options: [
      { text: "Strongly value cultural rituals and heritage", score: 5 },
      { text: "Respect traditions while welcoming modern flexibility", score: 4 },
      { text: "Prefer moderate balance depending on family needs", score: 3 },
      { text: "Strongly lean modern and secular", score: 2 },
    ],
  },
  {
    id: "VAL_02",
    dimension: "VALUES",
    questionText: "What is your philosophy on personal independence within marriage?",
    options: [
      { text: "Both partners must maintain individual goals, hobbies, and identity", score: 5 },
      { text: "Healthy balance of couple time and individual time", score: 4 },
      { text: "Family unity comes before personal autonomy", score: 3 },
      { text: "Prefer doing almost everything together as a unit", score: 2 },
    ],
  },
  {
    id: "COMM_01",
    dimension: "COMMUNICATION",
    questionText: "When a disagreement arises, what is your natural reaction?",
    options: [
      { text: "Calmly discuss the matter immediately until resolved", score: 5 },
      { text: "Take an hour to process thoughts, then discuss constructively", score: 4 },
      { text: "Prefer gentle indirect hints to preserve harmony", score: 3 },
      { text: "Need extended space before revisiting delicate topics", score: 2 },
    ],
  },
  {
    id: "COMM_02",
    dimension: "COMMUNICATION",
    questionText: "How do you prefer expressing love and appreciation to your spouse?",
    options: [
      { text: "Words of affirmation and sincere daily appreciation", score: 5 },
      { text: "Quality focused time without digital distractions", score: 4 },
      { text: "Acts of service and thoughtful support in everyday tasks", score: 3 },
      { text: "Thoughtful gifts and surprise gestures", score: 2 },
    ],
  },
  {
    id: "FIN_01",
    dimension: "FINANCES",
    questionText: "How do you view financial management and savings in marriage?",
    options: [
      { text: "Transparent joint budgeting with aggressive long-term investments", score: 5 },
      { text: "Combined household fund plus independent personal discretionary accounts", score: 4 },
      { text: "Shared expenses with focus on enjoying current life experiences", score: 3 },
      { text: "Traditional single-manager financial setup", score: 2 },
    ],
  },
  {
    id: "FAM_01",
    dimension: "FAMILY",
    questionText: "What are your expectations regarding living arrangements with parents / extended family?",
    options: [
      { text: "Living independently but maintaining close proximity and frequent visits", score: 5 },
      { text: "Living together in a warm joint family setting", score: 4 },
      { text: "Flexible depending on career and mutual comfort", score: 3 },
      { text: "Completely independent residence", score: 2 },
    ],
  },
  {
    id: "LIFE_01",
    dimension: "LIFESTYLE",
    questionText: "How do you enjoy spending typical weekends and holidays?",
    options: [
      { text: "Exploring new places, traveling, outdoor dining, and cultural events", score: 5 },
      { text: "Quiet cozy time at home with books, cooking, and close friends", score: 4 },
      { text: "Active sports, fitness routines, and personal development", score: 3 },
      { text: "Family gatherings and community social activities", score: 2 },
    ],
  },
  {
    id: "CAR_01",
    dimension: "CAREER",
    questionText: "How do you envision balancing dual career ambitions and family priorities?",
    options: [
      { text: "Both partners actively support each other's career growth equally", score: 5 },
      { text: "Adaptable roles where one partner can pivot during critical life stages", score: 4 },
      { text: "Work-life balance is prioritized over rapid corporate advancement", score: 3 },
      { text: "Clear division of primary provider and primary home manager", score: 2 },
    ],
  },
];

export class AssessmentService {
  static getQuestions() {
    return QUESTIONNAIRE_V1;
  }

  static async getAssessmentByUserId(userId: string): Promise<IAssessment | null> {
    return Assessment.findOne({ userId });
  }

  static async submitAssessment(userId: string, answers: IAssessmentAnswer[]): Promise<IAssessment> {
    const dimensionTotals: Record<string, { sum: number; count: number }> = {
      values: { sum: 0, count: 0 },
      communication: { sum: 0, count: 0 },
      finances: { sum: 0, count: 0 },
      family: { sum: 0, count: 0 },
      lifestyle: { sum: 0, count: 0 },
      career: { sum: 0, count: 0 },
    };

    answers.forEach((ans) => {
      const dim = ans.dimension.toLowerCase();
      if (dimensionTotals[dim]) {
        dimensionTotals[dim].sum += ans.numericScore;
        dimensionTotals[dim].count += 1;
      }
    });

    const dimensionScores = {
      values: dimensionTotals.values.count ? Math.round((dimensionTotals.values.sum / (dimensionTotals.values.count * 5)) * 100) : 75,
      communication: dimensionTotals.communication.count ? Math.round((dimensionTotals.communication.sum / (dimensionTotals.communication.count * 5)) * 100) : 80,
      finances: dimensionTotals.finances.count ? Math.round((dimensionTotals.finances.sum / (dimensionTotals.finances.count * 5)) * 100) : 70,
      family: dimensionTotals.family.count ? Math.round((dimensionTotals.family.sum / (dimensionTotals.family.count * 5)) * 100) : 85,
      lifestyle: dimensionTotals.lifestyle.count ? Math.round((dimensionTotals.lifestyle.sum / (dimensionTotals.lifestyle.count * 5)) * 100) : 75,
      career: dimensionTotals.career.count ? Math.round((dimensionTotals.career.sum / (dimensionTotals.career.count * 5)) * 100) : 80,
    };

    const assessment = await Assessment.findOneAndUpdate(
      { userId },
      {
        $set: {
          version: 1,
          answers,
          dimensionScores,
          isComplete: true,
          completedAt: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    return assessment;
  }

  static generateExplainableCompatibility(
    assessment1: IAssessment | null,
    assessment2: IAssessment | null
  ): { score: number; highlights: string[] } {
    if (!assessment1 || !assessment2) {
      return {
        score: 78,
        highlights: [
          "Mutual interest in balanced family values and open communication",
          "Aligned long-term goals for personal and career growth",
          "Complementary views on financial responsibility",
        ],
      };
    }

    const s1 = assessment1.dimensionScores;
    const s2 = assessment2.dimensionScores;

    const diffValues = Math.abs(s1.values - s2.values);
    const diffComm = Math.abs(s1.communication - s2.communication);
    const diffFin = Math.abs(s1.finances - s2.finances);
    const diffFam = Math.abs(s1.family - s2.family);
    const diffLife = Math.abs(s1.lifestyle - s2.lifestyle);
    const diffCar = Math.abs(s1.career - s2.career);

    const avgDiff = (diffValues + diffComm + diffFin + diffFam + diffLife + diffCar) / 6;
    const score = Math.max(60, Math.min(96, Math.round(100 - avgDiff * 0.8)));

    const highlights: string[] = [];
    if (diffComm <= 15) {
      highlights.push("Exceptionally aligned communication styles and constructive conflict resolution");
    }
    if (diffFam <= 15) {
      highlights.push("Strong harmony in family expectations, living arrangements, and parent care");
    }
    if (diffFin <= 20) {
      highlights.push("Shared philosophy regarding financial security and prudent investments");
    }
    if (diffCar <= 20) {
      highlights.push("Mutual understanding of career growth and work-life balance");
    }
    if (highlights.length < 2) {
      highlights.push("Shared vision for meaningful companionship and lifelong partnership");
      highlights.push("Compatible perspectives on family traditions and modern aspirations");
    }

    return { score, highlights };
  }
}
