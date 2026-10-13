import mongoose, { Schema, Document, Types } from "mongoose";

export interface IConsentRecord extends Document {
  userId: Types.ObjectId;
  termsAccepted: boolean;
  privacyPolicyAccepted: boolean;
  dpdpConsentAccepted: boolean;
  matchmakingConsentAccepted: boolean;
  ipAddress?: string;
  userAgent?: string;
  version: string;
  consentedAt: Date;
}

const ConsentRecordSchema = new Schema<IConsentRecord>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    termsAccepted: { type: Boolean, required: true },
    privacyPolicyAccepted: { type: Boolean, required: true },
    dpdpConsentAccepted: { type: Boolean, required: true },
    matchmakingConsentAccepted: { type: Boolean, required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
    version: { type: String, default: "1.0.0" },
    consentedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

export const ConsentRecord = mongoose.model<IConsentRecord>("ConsentRecord", ConsentRecordSchema);

export interface IDataDeletionRequest extends Document {
  userId: Types.ObjectId;
  reason?: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "REJECTED";
  requestedAt: Date;
  scheduledDeletionDate: Date;
  completedAt?: Date;
  adminNotes?: string;
}

const DataDeletionRequestSchema = new Schema<IDataDeletionRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reason: { type: String },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "COMPLETED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    requestedAt: { type: Date, default: Date.now },
    scheduledDeletionDate: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day grace period
    },
    completedAt: { type: Date },
    adminNotes: { type: String },
  },
  {
    timestamps: true,
  }
);

export const DataDeletionRequest = mongoose.model<IDataDeletionRequest>(
  "DataDeletionRequest",
  DataDeletionRequestSchema
);
