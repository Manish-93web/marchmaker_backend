import mongoose, { Schema, Document, Types } from "mongoose";

export type VerificationStatus = "PENDING" | "APPROVED" | "REJECTED" | "ACTION_REQUIRED";
export type DocumentType = "AADHAAR" | "PASSPORT" | "VOTER_ID" | "DRIVING_LICENSE";

export interface IVerificationRequest extends Document {
  userId: Types.ObjectId;
  documentType: DocumentType;
  maskedDocumentNumber: string;
  documentUrl: string;
  selfieUrl: string;
  status: VerificationStatus;
  reviewerId?: Types.ObjectId;
  rejectionReason?: string;
  actionRequiredMessage?: string;
  submittedAt: Date;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const VerificationRequestSchema = new Schema<IVerificationRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    documentType: {
      type: String,
      enum: ["AADHAAR", "PASSPORT", "VOTER_ID", "DRIVING_LICENSE"],
      required: true,
    },
    maskedDocumentNumber: {
      type: String,
      required: true,
    },
    documentUrl: {
      type: String,
      required: true,
    },
    selfieUrl: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "ACTION_REQUIRED"],
      default: "PENDING",
      index: true,
    },
    reviewerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    rejectionReason: {
      type: String,
    },
    actionRequiredMessage: {
      type: String,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    reviewedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

VerificationRequestSchema.index({ userId: 1, status: 1 });
VerificationRequestSchema.index({ status: 1, submittedAt: 1 });

export const VerificationRequest = mongoose.model<IVerificationRequest>(
  "VerificationRequest",
  VerificationRequestSchema
);
