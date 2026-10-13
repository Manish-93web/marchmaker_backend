import mongoose, { Schema, Document, Types } from "mongoose";

export type UserRole = "MEMBER" | "REVIEWER" | "MODERATOR" | "SUPPORT_AGENT" | "FINANCE_ADMIN" | "SUPER_ADMIN";

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  fullName: string;
  phone?: string;
  role: UserRole;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  isSuspended: boolean;
  suspendedReason?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ["MEMBER", "REVIEWER", "MODERATOR", "SUPPORT_AGENT", "FINANCE_ADMIN", "SUPER_ADMIN"],
      default: "MEMBER",
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
      index: true,
    },
    suspendedReason: {
      type: String,
    },
    lastLoginAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
UserSchema.index({ email: 1, role: 1 });
UserSchema.index({ createdAt: -1 });

export const User = mongoose.model<IUser>("User", UserSchema);
