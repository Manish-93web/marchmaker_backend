import mongoose, { Schema, Document, Types } from "mongoose";

export interface IAssessmentAnswer {
  questionId: string;
  dimension: "VALUES" | "COMMUNICATION" | "FINANCES" | "FAMILY" | "LIFESTYLE" | "CAREER";
  questionText: string;
  selectedOption: string;
  numericScore: number; // 1 to 5 scale
}

export interface IAssessment extends Document {
  userId: Types.ObjectId;
  version: number;
  answers: IAssessmentAnswer[];
  dimensionScores: {
    values: number;
    communication: number;
    finances: number;
    family: number;
    lifestyle: number;
    career: number;
  };
  isComplete: boolean;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AssessmentAnswerSchema = new Schema<IAssessmentAnswer>({
  questionId: { type: String, required: true },
  dimension: {
    type: String,
    enum: ["VALUES", "COMMUNICATION", "FINANCES", "FAMILY", "LIFESTYLE", "CAREER"],
    required: true,
  },
  questionText: { type: String, required: true },
  selectedOption: { type: String, required: true },
  numericScore: { type: Number, required: true, min: 1, max: 5 },
});

const AssessmentSchema = new Schema<IAssessment>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    version: { type: Number, default: 1 },
    answers: [AssessmentAnswerSchema],
    dimensionScores: {
      values: { type: Number, default: 0 },
      communication: { type: Number, default: 0 },
      finances: { type: Number, default: 0 },
      family: { type: Number, default: 0 },
      lifestyle: { type: Number, default: 0 },
      career: { type: Number, default: 0 },
    },
    isComplete: { type: Boolean, default: false, index: true },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

export const Assessment = mongoose.model<IAssessment>("Assessment", AssessmentSchema);
