import mongoose, { Schema, Document, Types } from "mongoose";

export interface IEmailVerificationToken extends Document {
  userId: Types.ObjectId;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

const EmailVerificationTokenSchema = new Schema<IEmailVerificationToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL auto-purge
  },
  { timestamps: true }
);

export const EmailVerificationToken = mongoose.model<IEmailVerificationToken>(
  "EmailVerificationToken",
  EmailVerificationTokenSchema
);

export interface IPhoneVerificationOtp extends Document {
  userId: Types.ObjectId;
  phone: string;
  otp: string;
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
}

const PhoneVerificationOtpSchema = new Schema<IPhoneVerificationOtp>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    phone: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL 10 minutes
  },
  { timestamps: true }
);

export const PhoneVerificationOtp = mongoose.model<IPhoneVerificationOtp>(
  "PhoneVerificationOtp",
  PhoneVerificationOtpSchema
);

export interface IPasswordResetToken extends Document {
  userId: Types.ObjectId;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

const PasswordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL 1 hour
  },
  { timestamps: true }
);

export const PasswordResetToken = mongoose.model<IPasswordResetToken>(
  "PasswordResetToken",
  PasswordResetTokenSchema
);
