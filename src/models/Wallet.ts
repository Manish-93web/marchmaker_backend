import mongoose, { Schema, Document, Types } from "mongoose";

export interface IWalletAccount extends Document {
  userId: Types.ObjectId;
  balanceINR: number;
  referralCode: string;
  referredByCode?: string;
  totalEarnedINR: number;
  totalSpentINR: number;
  createdAt: Date;
  updatedAt: Date;
}

const WalletAccountSchema = new Schema<IWalletAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    balanceINR: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    referredByCode: {
      type: String,
      uppercase: true,
      trim: true,
    },
    totalEarnedINR: {
      type: Number,
      default: 0,
    },
    totalSpentINR: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

export const WalletAccount = mongoose.model<IWalletAccount>("WalletAccount", WalletAccountSchema);

export type LedgerEntryType = "CREDIT" | "DEBIT";

export interface IWalletLedgerEntry extends Document {
  walletId: Types.ObjectId;
  userId: Types.ObjectId;
  type: LedgerEntryType;
  amountINR: number;
  balanceAfterINR: number;
  reason: string;
  idempotencyKey: string;
  referenceType?: "REFERRAL_BONUS" | "INTRODUCTION_PURCHASE" | "ADMIN_ADJUSTMENT" | "REFUND";
  referenceId?: string;
  createdAt: Date;
}

const WalletLedgerEntrySchema = new Schema<IWalletLedgerEntry>(
  {
    walletId: {
      type: Schema.Types.ObjectId,
      ref: "WalletAccount",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["CREDIT", "DEBIT"],
      required: true,
    },
    amountINR: {
      type: Number,
      required: true,
      min: 1,
    },
    balanceAfterINR: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    referenceType: {
      type: String,
      enum: ["REFERRAL_BONUS", "INTRODUCTION_PURCHASE", "ADMIN_ADJUSTMENT", "REFUND"],
    },
    referenceId: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

WalletLedgerEntrySchema.index({ userId: 1, createdAt: -1 });

export const WalletLedgerEntry = mongoose.model<IWalletLedgerEntry>(
  "WalletLedgerEntry",
  WalletLedgerEntrySchema
);
