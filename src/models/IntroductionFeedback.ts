import mongoose, { Schema, Document, Types } from "mongoose";

export interface IIntroductionFeedback extends Document {
  introductionId: Types.ObjectId;
  userId: Types.ObjectId;
  candidateId: Types.ObjectId;
  relevanceRating: number; // 1 to 5
  expectationsMet: "YES" | "PARTIALLY" | "NO";
  communicationFeedback?: string;
  feedbackNotes?: string;
  createdAt: Date;
}

const IntroductionFeedbackSchema = new Schema<IIntroductionFeedback>(
  {
    introductionId: {
      type: Schema.Types.ObjectId,
      ref: "Introduction",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    relevanceRating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    expectationsMet: {
      type: String,
      enum: ["YES", "PARTIALLY", "NO"],
      required: true,
    },
    communicationFeedback: {
      type: String,
    },
    feedbackNotes: {
      type: String,
      maxlength: 1000,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

IntroductionFeedbackSchema.index({ introductionId: 1, userId: 1 }, { unique: true });

export const IntroductionFeedback = mongoose.model<IIntroductionFeedback>(
  "IntroductionFeedback",
  IntroductionFeedbackSchema
);
