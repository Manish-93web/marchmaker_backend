import mongoose, { Schema, Document, Types } from "mongoose";

export interface IAuditLog extends Document {
  actorId: Types.ObjectId;
  actorRole: string;
  action: string;
  targetCollection: string;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, any>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorRole: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    targetCollection: {
      type: String,
      required: true,
      index: true,
    },
    targetId: {
      type: String,
      index: true,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
    details: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

AuditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
