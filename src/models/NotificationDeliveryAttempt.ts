import mongoose, { Schema, Document, Types } from "mongoose";

export type DeliveryChannel = "EMAIL" | "SMS" | "WHATSAPP" | "IN_APP";
export type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "RETRYING";

export interface INotificationDeliveryAttempt extends Document {
  recipient: string;
  recipientUserId?: Types.ObjectId;
  channel: DeliveryChannel;
  template: string;
  status: DeliveryStatus;
  provider: string;
  providerMessageId?: string;
  errorMessage?: string;
  attemptCount: number;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationDeliveryAttemptSchema = new Schema<INotificationDeliveryAttempt>(
  {
    recipient: {
      type: String,
      required: true,
      index: true,
    },
    recipientUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    channel: {
      type: String,
      enum: ["EMAIL", "SMS", "WHATSAPP", "IN_APP"],
      required: true,
      index: true,
    },
    template: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "DELIVERED", "FAILED", "RETRYING"],
      default: "PENDING",
      index: true,
    },
    provider: {
      type: String,
      required: true,
    },
    providerMessageId: {
      type: String,
    },
    errorMessage: {
      type: String,
    },
    attemptCount: {
      type: Number,
      default: 1,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Expire logs after 90 days
NotificationDeliveryAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const NotificationDeliveryAttempt = mongoose.model<INotificationDeliveryAttempt>(
  "NotificationDeliveryAttempt",
  NotificationDeliveryAttemptSchema
);
