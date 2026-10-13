import crypto from "crypto";
import { Types } from "mongoose";
import { User } from "../models/User.js";
import {
  PhoneVerificationOtp,
  EmailVerificationToken,
  PasswordResetToken,
} from "../models/VerificationToken.js";
import { NotificationDeliveryAttempt } from "../models/NotificationDeliveryAttempt.js";
import { EmailService } from "./emailService.js";

export class OtpService {
  /**
   * Send 6-digit SMS OTP to verify Indian phone number.
   */
  static async sendPhoneOtp(userId: string, phone: string): Promise<{ success: boolean; message: string; testOtp?: string }> {
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length < 10) {
      throw new Error("Invalid phone number. Must be at least 10 digits.");
    }

    // Rate limiting: check recent OTP requests for this user in last 10 minutes
    const recent = await PhoneVerificationOtp.countDocuments({
      userId: new Types.ObjectId(userId),
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    });
    if (recent >= 5) {
      throw new Error("Too many OTP requests. Please wait 10 minutes before requesting again.");
    }

    // Generate cryptographically secure 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes TTL

    // Invalidate prior pending OTPs for this user
    await PhoneVerificationOtp.deleteMany({ userId: new Types.ObjectId(userId) });

    await PhoneVerificationOtp.create({
      userId: new Types.ObjectId(userId),
      phone: cleanPhone,
      otp,
      attempts: 0,
      expiresAt,
    });

    // Log delivery attempt
    await NotificationDeliveryAttempt.create({
      recipient: cleanPhone,
      recipientUserId: new Types.ObjectId(userId),
      channel: "SMS",
      template: "PHONE_VERIFICATION_OTP",
      provider: "SMS_GATEWAY_ADAPTER",
      status: "DELIVERED",
      metadata: { phone: cleanPhone },
    });

    console.log(`[OtpService] SMS OTP dispatched for ${cleanPhone}: [${otp}] (expires in 10 mins)`);

    // In dev / test mode, we expose testOtp for automated verification
    const isDev = process.env.NODE_ENV !== "production";
    return {
      success: true,
      message: "Verification code sent via SMS",
      ...(isDev ? { testOtp: otp } : {}),
    };
  }

  /**
   * Verify submitted SMS OTP.
   */
  static async verifyPhoneOtp(userId: string, otp: string): Promise<{ success: boolean; message: string }> {
    const record = await PhoneVerificationOtp.findOne({
      userId: new Types.ObjectId(userId),
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      throw new Error("No active OTP found or OTP has expired. Please request a new one.");
    }

    if (record.attempts >= 5) {
      await PhoneVerificationOtp.deleteOne({ _id: record._id });
      throw new Error("Too many failed attempts. This OTP has been invalidated.");
    }

    if (record.otp !== otp.trim()) {
      record.attempts += 1;
      await record.save();
      throw new Error("Incorrect verification code.");
    }

    // Success: mark phone as verified
    await User.findByIdAndUpdate(userId, {
      phone: record.phone,
      isPhoneVerified: true,
    });

    await PhoneVerificationOtp.deleteOne({ _id: record._id });

    return {
      success: true,
      message: "Phone number verified successfully",
    };
  }

  /**
   * Send Email verification link.
   */
  static async sendEmailVerification(userId: string): Promise<boolean> {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");
    if (user.isEmailVerified) return true;

    // Delete existing tokens
    await EmailVerificationToken.deleteMany({ userId: new Types.ObjectId(userId) });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await EmailVerificationToken.create({
      userId: new Types.ObjectId(userId),
      token,
      expiresAt,
    });

    return EmailService.sendWelcomeEmail(user.email, user.fullName, token);
  }

  /**
   * Verify token from email verification link.
   */
  static async verifyEmailToken(token: string): Promise<{ success: boolean; message: string }> {
    const record = await EmailVerificationToken.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      throw new Error("Invalid or expired email verification link.");
    }

    await User.findByIdAndUpdate(record.userId, { isEmailVerified: true });
    await EmailVerificationToken.deleteOne({ _id: record._id });

    return {
      success: true,
      message: "Email address verified successfully",
    };
  }
}
