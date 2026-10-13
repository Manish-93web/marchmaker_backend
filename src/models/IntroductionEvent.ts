import mongoose, { Schema, Document, Types } from "mongoose";

export interface IIntroductionEvent extends Document {
  introductionId: Types.ObjectId;
  fromState: string;
  toState: string;
  actorId: Types.ObjectId;
  actorRole: string;
  reason?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const IntroductionEventSchema = new Schema<IIntroductionEvent>(
  {
    introductionId: {
      type: Schema.Types.ObjectId,
      ref: "Introduction",
      required: true,
      index: true,
    },
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true },
    reason: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

IntroductionEventSchema.index({ introductionId: 1, createdAt: 1 });

export const IntroductionEvent = mongoose.model<IIntroductionEvent>(
  "IntroductionEvent",
  IntroductionEventSchema
);
