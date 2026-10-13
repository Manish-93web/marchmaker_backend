import mongoose, { Schema, Document, Types } from "mongoose";

export type ReportSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ReportStatus = "PENDING" | "INVESTIGATING" | "ACTIONED" | "DISMISSED";

export interface IReport extends Document {
  reporterId: Types.ObjectId;
  reportedUserId: Types.ObjectId;
  introductionId?: Types.ObjectId;
  reason: string;
  details: string;
  severity: ReportSeverity;
  status: ReportStatus;
  moderatorId?: Types.ObjectId;
  moderatorNotes?: string;
  actionTaken?: "NO_ACTION" | "WARNING_ISSUED" | "PROFILE_SUSPENDED" | "PERMANENT_BAN";
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reportedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    introductionId: {
      type: Schema.Types.ObjectId,
      ref: "Introduction",
    },
    reason: {
      type: String,
      required: true,
    },
    details: {
      type: String,
      required: true,
    },
    severity: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
      index: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "INVESTIGATING", "ACTIONED", "DISMISSED"],
      default: "PENDING",
      index: true,
    },
    moderatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    moderatorNotes: {
      type: String,
    },
    actionTaken: {
      type: String,
      enum: ["NO_ACTION", "WARNING_ISSUED", "PROFILE_SUSPENDED", "PERMANENT_BAN"],
    },
  },
  {
    timestamps: true,
  }
);

ReportSchema.index({ status: 1, severity: 1 });

export const Report = mongoose.model<IReport>("Report", ReportSchema);

// Blocked User list
export interface IBlockedUser extends Document {
  userId: Types.ObjectId;
  blockedUserId: Types.ObjectId;
  createdAt: Date;
}

const BlockedUserSchema = new Schema<IBlockedUser>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    blockedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

BlockedUserSchema.index({ userId: 1, blockedUserId: 1 }, { unique: true });

export const BlockedUser = mongoose.model<IBlockedUser>("BlockedUser", BlockedUserSchema);
