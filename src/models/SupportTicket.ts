import mongoose, { Schema, Document, Types } from "mongoose";

export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export interface ISupportMessage {
  senderId: Types.ObjectId;
  senderRole: string;
  message: string;
  sentAt: Date;
}

export interface ISupportTicket extends Document {
  ticketNumber: string;
  userId: Types.ObjectId;
  subject: string;
  category: "PROFILE" | "VERIFICATION" | "INTRODUCTION" | "PAYMENT" | "PRIVACY" | "OTHER";
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: Types.ObjectId;
  messages: ISupportMessage[];
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SupportMessageSchema = new Schema<ISupportMessage>({
  senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  senderRole: { type: String, required: true },
  message: { type: String, required: true, maxlength: 4000 },
  sentAt: { type: Date, default: Date.now },
});

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      maxlength: 200,
    },
    category: {
      type: String,
      enum: ["PROFILE", "VERIFICATION", "INTRODUCTION", "PAYMENT", "PRIVACY", "OTHER"],
      default: "OTHER",
      index: true,
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      default: "MEDIUM",
      index: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "OPEN",
      index: true,
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    messages: [SupportMessageSchema],
    resolvedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

SupportTicketSchema.index({ status: 1, priority: 1 });
SupportTicketSchema.index({ userId: 1, status: 1 });

export const SupportTicket = mongoose.model<ISupportTicket>("SupportTicket", SupportTicketSchema);
