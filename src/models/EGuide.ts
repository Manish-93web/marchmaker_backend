import mongoose, { Schema, Document, Types } from "mongoose";

export interface IEGuideContent extends Document {
  title: string;
  slug: string;
  category: "VALUES_ALIGNMENT" | "FAMILY_COMMUNICATION" | "FINANCIAL_HEALTH" | "INTIMACY_AND_BOUNDARIES";
  summary: string;
  bodyMarkdown: string;
  audioUrl?: string;
  durationSeconds?: number;
  transcriptText?: string;
  order: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const EGuideContentSchema = new Schema<IEGuideContent>(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    category: {
      type: String,
      enum: ["VALUES_ALIGNMENT", "FAMILY_COMMUNICATION", "FINANCIAL_HEALTH", "INTIMACY_AND_BOUNDARIES"],
      required: true,
      index: true,
    },
    summary: { type: String, required: true },
    bodyMarkdown: { type: String, required: true },
    audioUrl: { type: String },
    durationSeconds: { type: Number, default: 0 },
    transcriptText: { type: String },
    order: { type: Number, default: 1 },
    isPublished: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export const EGuideContent = mongoose.model<IEGuideContent>("EGuideContent", EGuideContentSchema);

export interface IEGuideProgress extends Document {
  userId: Types.ObjectId;
  guideId: Types.ObjectId;
  playbackPositionSeconds: number;
  isCompleted: boolean;
  lastListenedAt: Date;
}

const EGuideProgressSchema = new Schema<IEGuideProgress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    guideId: { type: Schema.Types.ObjectId, ref: "EGuideContent", required: true, index: true },
    playbackPositionSeconds: { type: Number, default: 0 },
    isCompleted: { type: Boolean, default: false },
    lastListenedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

EGuideProgressSchema.index({ userId: 1, guideId: 1 }, { unique: true });

export const EGuideProgress = mongoose.model<IEGuideProgress>("EGuideProgress", EGuideProgressSchema);
