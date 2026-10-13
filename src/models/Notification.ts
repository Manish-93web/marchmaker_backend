import mongoose, { Schema, Document, Types } from "mongoose";

export type NotificationCategory =
  | "VERIFICATION"
  | "INTRODUCTION"
  | "PAYMENT"
  | "SUPPORT"
  | "SECURITY"
  | "SYSTEM";

export interface INotification extends Document {
  userId: Types.ObjectId;
  title: string;
  message: string;
  category: NotificationCategory;
  deepLink?: string;
  isRead: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: ["VERIFICATION", "INTRODUCTION", "PAYMENT", "SUPPORT", "SECURITY", "SYSTEM"],
      default: "SYSTEM",
      index: true,
    },
    deepLink: {
      type: String,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>("Notification", NotificationSchema);
