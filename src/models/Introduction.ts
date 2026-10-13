import mongoose, { Schema, Document, Types } from "mongoose";

export type IntroductionStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED_BY_REVIEWER"
  | "OFFERED"
  | "PAYMENT_PENDING"
  | "UNLOCKED"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELLED"
  | "COMPLETED"
  | "REFUNDED"
  | "REQUIRES_SUPPORT";

export interface IIntroductionNote {
  senderId: Types.ObjectId;
  content: string;
  sentAt: Date;
}

export interface IIntroduction extends Document {
  member1Id: Types.ObjectId;
  member2Id: Types.ObjectId;
  reviewerId?: Types.ObjectId;
  status: IntroductionStatus;
  compatibilityScore: number;
  explainableHighlights: string[];
  reviewerNotes?: string;
  reviewDeclineReason?: string;
  reviewPriority: "NORMAL" | "HIGH" | "URGENT";
  isEscalated: boolean;
  escalationReason?: string;
  escalatedAt?: Date;
  member1Decision: "NONE" | "ACCEPTED" | "DECLINED";
  member2Decision: "NONE" | "ACCEPTED" | "DECLINED";
  member1DeclineReason?: string;
  member2DeclineReason?: string;
  member1Unlocked: boolean;
  member2Unlocked: boolean;
  member1PaymentId?: Types.ObjectId;
  member2PaymentId?: Types.ObjectId;
  notesExchange: IIntroductionNote[];
  offeredAt?: Date;
  expiresAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const IntroductionNoteSchema = new Schema<IIntroductionNote>({
  senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true, maxlength: 1000 },
  sentAt: { type: Date, default: Date.now },
});

const IntroductionSchema = new Schema<IIntroduction>(
  {
    member1Id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    member2Id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reviewerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    status: {
      type: String,
      enum: [
        "DRAFT",
        "PENDING_REVIEW",
        "APPROVED",
        "REJECTED_BY_REVIEWER",
        "OFFERED",
        "PAYMENT_PENDING",
        "UNLOCKED",
        "ACCEPTED",
        "DECLINED",
        "EXPIRED",
        "CANCELLED",
        "COMPLETED",
        "REFUNDED",
        "REQUIRES_SUPPORT",
      ],
      default: "PENDING_REVIEW",
      index: true,
    },
    compatibilityScore: { type: Number, required: true, min: 0, max: 100 },
    explainableHighlights: { type: [String], default: [] },
    reviewerNotes: { type: String },
    reviewDeclineReason: { type: String },
    reviewPriority: { type: String, enum: ["NORMAL", "HIGH", "URGENT"], default: "NORMAL", index: true },
    isEscalated: { type: Boolean, default: false, index: true },
    escalationReason: { type: String },
    escalatedAt: { type: Date },
    member1Decision: {
      type: String,
      enum: ["NONE", "ACCEPTED", "DECLINED"],
      default: "NONE",
    },
    member2Decision: {
      type: String,
      enum: ["NONE", "ACCEPTED", "DECLINED"],
      default: "NONE",
    },
    member1DeclineReason: { type: String },
    member2DeclineReason: { type: String },
    member1Unlocked: { type: Boolean, default: false },
    member2Unlocked: { type: Boolean, default: false },
    member1PaymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    member2PaymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    notesExchange: [IntroductionNoteSchema],
    offeredAt: { type: Date },
    expiresAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
IntroductionSchema.index({ member1Id: 1, member2Id: 1 }, { unique: true });
IntroductionSchema.index({ status: 1, reviewerId: 1 });
IntroductionSchema.index({ member1Id: 1, status: 1 });
IntroductionSchema.index({ member2Id: 1, status: 1 });

export const Introduction = mongoose.model<IIntroduction>("Introduction", IntroductionSchema);
