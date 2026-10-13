import mongoose, { Schema, Document, Types } from "mongoose";

export interface IInvoice extends Document {
  invoiceNumber: string;
  userId: Types.ObjectId;
  paymentId: Types.ObjectId;
  introductionId: Types.ObjectId;
  billingName: string;
  billingEmail: string;
  billingState: string;
  baseAmountINR: number;
  cgstAmountINR: number;
  sgstAmountINR: number;
  totalAmountINR: number;
  sacCode: string;
  pdfUrl?: string;
  invoiceDate: Date;
  createdAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: {
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
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      required: true,
      unique: true,
    },
    introductionId: {
      type: Schema.Types.ObjectId,
      ref: "Introduction",
      required: true,
    },
    billingName: {
      type: String,
      required: true,
    },
    billingEmail: {
      type: String,
      required: true,
    },
    billingState: {
      type: String,
      default: "Delhi",
    },
    baseAmountINR: {
      type: Number,
      required: true,
    },
    cgstAmountINR: {
      type: Number,
      required: true,
    },
    sgstAmountINR: {
      type: Number,
      required: true,
    },
    totalAmountINR: {
      type: Number,
      required: true,
    },
    sacCode: {
      type: String,
      default: "998399", // Matrimonial / Personal Matching Service
    },
    pdfUrl: {
      type: String,
    },
    invoiceDate: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

export const Invoice = mongoose.model<IInvoice>("Invoice", InvoiceSchema);
