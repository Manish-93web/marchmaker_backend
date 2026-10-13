import mongoose, { Schema, Document, Types } from "mongoose";

export type PaymentStatus = "CREATED" | "CAPTURED" | "FAILED" | "REFUNDED" | "REFUND_PENDING";
export type RefundStatus = "NONE" | "REQUESTED" | "PROCESSING" | "PROCESSED" | "FAILED";

export interface IPayment extends Document {
  userId: Types.ObjectId;
  introductionId: Types.ObjectId;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  amountINR: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  invoiceId?: Types.ObjectId;
  refundId?: string;
  refundRazorpayId?: string;
  refundAmountINR?: number;
  refundStatus: RefundStatus;
  refundReason?: string;
  refundRequestedAt?: Date;
  refundedAt?: Date;
  failureReason?: string;
  processedWebhookEvents: string[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    introductionId: {
      type: Schema.Types.ObjectId,
      ref: "Introduction",
      required: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
    },
    amountINR: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "INR",
    },
    status: {
      type: String,
      enum: ["CREATED", "CAPTURED", "FAILED", "REFUNDED"],
      default: "CREATED",
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
    },
    refundId: { type: String },
    refundRazorpayId: { type: String },
    refundAmountINR: { type: Number },
    refundStatus: { type: String, enum: ["NONE", "REQUESTED", "PROCESSING", "PROCESSED", "FAILED"], default: "NONE", index: true },
    refundReason: { type: String },
    refundRequestedAt: { type: Date },
    refundedAt: { type: Date },
    failureReason: { type: String },
    processedWebhookEvents: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

PaymentSchema.index({ userId: 1, status: 1 });
PaymentSchema.index({ introductionId: 1, userId: 1 });

export const Payment = mongoose.model<IPayment>("Payment", PaymentSchema);
