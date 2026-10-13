import { Types } from "mongoose";
import {
  VerificationRequest,
  IVerificationRequest,
  VerificationStatus,
  DocumentType,
} from "../models/VerificationRequest.js";
import { Notification } from "../models/Notification.js";
import { AuditLog } from "../models/AuditLog.js";

export class VerificationService {
  static async submitRequest(data: {
    userId: string;
    documentType: DocumentType;
    documentNumber: string;
    documentUrl: string;
    selfieUrl: string;
  }): Promise<IVerificationRequest> {
    // Mask document number (e.g., Aadhaar "XXXXXXXX1234")
    const masked =
      data.documentNumber.length > 4
        ? "X".repeat(data.documentNumber.length - 4) + data.documentNumber.slice(-4)
        : "****";

    const request = await VerificationRequest.create({
      userId: new Types.ObjectId(data.userId),
      documentType: data.documentType,
      maskedDocumentNumber: masked,
      documentUrl: data.documentUrl,
      selfieUrl: data.selfieUrl,
      status: "PENDING",
      submittedAt: new Date(),
    });

    await Notification.create({
      userId: data.userId,
      title: "KYC Documents Received",
      message: "Your identity verification documents are under review by our verification desk. Expected turnaround: 12-24 hours.",
      category: "VERIFICATION",
      deepLink: "/dashboard/verification",
    });

    return request;
  }

  static async getLatestByUser(userId: string): Promise<IVerificationRequest | null> {
    return VerificationRequest.findOne({ userId }).sort({ createdAt: -1 });
  }

  static async getPendingRequests(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [requests, total] = await Promise.all([
      VerificationRequest.find({ status: "PENDING" })
        .populate("userId", "fullName email phone")
        .sort({ submittedAt: 1 })
        .skip(skip)
        .limit(limit),
      VerificationRequest.countDocuments({ status: "PENDING" }),
    ]);

    return { requests, total, page, totalPages: Math.ceil(total / limit) };
  }

  static async reviewRequest(data: {
    requestId: string;
    reviewerId: string;
    decision: "APPROVE" | "REJECT" | "REQUEST_INFO";
    reason?: string;
  }): Promise<IVerificationRequest> {
    const request = await VerificationRequest.findById(data.requestId);
    if (!request) {
      throw new Error("Verification request not found");
    }

    let newStatus: VerificationStatus = "PENDING";
    if (data.decision === "APPROVE") newStatus = "APPROVED";
    if (data.decision === "REJECT") newStatus = "REJECTED";
    if (data.decision === "REQUEST_INFO") newStatus = "ACTION_REQUIRED";

    request.status = newStatus;
    request.reviewerId = new Types.ObjectId(data.reviewerId);
    request.rejectionReason = data.reason;
    request.reviewedAt = new Date();
    await request.save();

    // Audit log
    await AuditLog.create({
      actorId: new Types.ObjectId(data.reviewerId),
      actorRole: "REVIEWER",
      action: `VERIFICATION_${data.decision}`,
      targetCollection: "VerificationRequest",
      targetId: request._id.toString(),
      details: { decision: data.decision, reason: data.reason },
    });

    // Notify user
    let title = "Verification Update";
    let message = "Your profile verification status has been updated.";
    if (newStatus === "APPROVED") {
      title = "Identity Verified! ✅";
      message = "Congratulations! Your profile is verified and active in our curated matchmaking pool.";
    } else if (newStatus === "REJECTED") {
      title = "Verification Unsuccessful";
      message = `Verification could not be approved: ${data.reason || "Document mismatch"}. Please submit fresh documents.`;
    } else if (newStatus === "ACTION_REQUIRED") {
      title = "Additional Action Required";
      message = `Our team requested additional clarity: ${data.reason}. Please update your submission.`;
    }

    await Notification.create({
      userId: request.userId,
      title,
      message,
      category: "VERIFICATION",
      deepLink: "/dashboard/verification",
    });

    try {
      const { EmailService } = await import("./emailService.js");
      const { User } = await import("../models/User.js");
      const user = await User.findById(request.userId);
      if (user) {
        await EmailService.sendKycStatusEmail(user.email, user.fullName, newStatus as any, data.reason);
      }
    } catch (e) {
      console.warn("[VerificationService] Email delivery warning:", e);
    }

    return request;
  }
}
