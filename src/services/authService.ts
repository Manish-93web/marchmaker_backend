import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { User, IUser, UserRole } from "../models/User.js";
import { Session } from "../models/Session.js";
import { WalletAccount } from "../models/Wallet.js";
import { MemberProfile } from "../models/MemberProfile.js";
import { PartnerPreferences } from "../models/PartnerPreferences.js";
import { Notification } from "../models/Notification.js";

export class AuthService {
  static async register(data: {
    email: string;
    password: string;
    fullName: string;
    phone?: string;
    referredByCode?: string;
    role?: UserRole;
  }): Promise<{ user: Partial<IUser>; token: string }> {
    const existing = await User.findOne({ email: data.email.toLowerCase() });
    if (existing) {
      throw new Error("An account with this email address already exists");
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(data.password, salt);

    const user = await User.create({
      email: data.email.toLowerCase(),
      passwordHash,
      fullName: data.fullName,
      phone: data.phone,
      role: data.role || "MEMBER",
      isEmailVerified: true, // Auto-verified for seamless testing/onboarding
    });

    // Create associated initial MemberProfile
    await MemberProfile.create({
      userId: user._id,
      fullName: user.fullName,
      gender: "MALE", // Default, editable in onboarding
      stepCompleted: 1,
      completionPercentage: 20,
      isProfileSubmitted: false,
      photos: [],
    });

    // Create default PartnerPreferences
    await PartnerPreferences.create({
      userId: user._id,
      ageMin: 22,
      ageMax: 32,
      heightCmMin: 152,
      heightCmMax: 185,
    });

    // Generate unique referral code: e.g. "MANISH-8492"
    const cleanName = user.fullName.replace(/[^a-zA-Z]/g, "").slice(0, 6).toUpperCase() || "MATCH";
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const referralCode = `${cleanName}-${randomSuffix}`;

    await WalletAccount.create({
      userId: user._id,
      balanceINR: 0,
      referralCode,
      referredByCode: data.referredByCode?.toUpperCase(),
    });

    // Welcome Notification
    await Notification.create({
      userId: user._id,
      title: "Welcome to Marchmaker",
      message: "Your profile has been created. Complete your guided profile journey to get verified and discover hand-reviewed matches.",
      category: "SYSTEM",
      deepLink: "/onboarding",
    });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role, nonce: Math.random().toString(36).substring(2) },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as any }
    );

    await Session.create({
      userId: user._id,
      token,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      isValid: true,
    });

    return {
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
      token,
    };
  }

  static async login(
    email: string,
    password: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<{ user: Partial<IUser>; token: string }> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      throw new Error("Invalid email or password");
    }

    if (user.isSuspended) {
      throw new Error(`Account suspended: ${user.suspendedReason || "Contact support"}`);
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new Error("Invalid email or password");
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role, nonce: Math.random().toString(36).substring(2) },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as any }
    );

    await Session.create({
      userId: user._id,
      token,
      userAgent,
      ipAddress,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      isValid: true,
    });

    return {
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
      token,
    };
  }

  static async logout(token: string): Promise<void> {
    await Session.updateOne({ token }, { isValid: false });
  }

  static async getMe(userId: string): Promise<IUser | null> {
    return User.findById(userId).select("-passwordHash");
  }

  static async forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Return ambiguous success to prevent user enumeration
      return { success: true, message: "If an account exists, a password reset link has been dispatched." };
    }

    const resetToken = jwt.sign(
      { userId: user._id.toString(), type: "RESET_PASSWORD" },
      config.jwtSecret,
      { expiresIn: "1h" }
    );

    // Notification / email
    await Notification.create({
      userId: user._id,
      title: "Password Reset Requested",
      message: "A password reset request was initiated for your account. If this was you, use the secure link.",
      category: "SECURITY",
      deepLink: `/reset-password?token=${resetToken}`,
    });

    try {
      const { EmailService } = await import("./emailService.js");
      await EmailService.sendPasswordResetEmail(user.email, user.fullName, resetToken);
    } catch (e) {
      console.warn("[AuthService] Email dispatch failed:", e);
    }

    return { success: true, message: "If an account exists, a password reset link has been dispatched." };
  }

  static async resetPassword(token: string, newPassword: string): Promise<{ success: boolean }> {
    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      throw new Error("Password reset token is invalid or expired.");
    }

    if (decoded.type !== "RESET_PASSWORD") {
      throw new Error("Invalid token type.");
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await User.findByIdAndUpdate(decoded.userId, { passwordHash });
    // Invalidate all active sessions for security
    await Session.updateMany({ userId: decoded.userId }, { isValid: false });

    return { success: true };
  }

  static async changePassword(userId: string, currentPass: string, newPass: string): Promise<{ success: boolean }> {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found.");

    const isMatch = await bcrypt.compare(currentPass, user.passwordHash);
    if (!isMatch) throw new Error("Current password is incorrect.");

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPass, salt);
    await user.save();

    return { success: true };
  }

  static async verifyEmail(userId: string): Promise<{ success: boolean }> {
    await User.findByIdAndUpdate(userId, { isEmailVerified: true });
    return { success: true };
  }
}
