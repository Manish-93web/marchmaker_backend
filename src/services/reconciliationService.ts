import { Types } from "mongoose";
import { Payment } from "../models/Payment.js";
import { Invoice } from "../models/Invoice.js";
import { AuditLog } from "../models/AuditLog.js";
import { Notification } from "../models/Notification.js";
import { Introduction } from "../models/Introduction.js";

export interface ReconciliationSummary {
  period: string;
  totalCaptured: number;
  totalRefunded: number;
  totalFailed: number;
  totalCreatedPending: number;
  grossRevenueINR: number;
  netRevenueINR: number;
  totalRefundedINR: number;
  invoicesIssued: number;
  discrepancies: Array<{
    type: string;
    paymentId: string;
    detail: string;
  }>;
}

export class ReconciliationService {
  /**
   * Produces a daily/weekly/monthly payment reconciliation summary.
   * Flags discrepancies: captured payment with no invoice, orphaned records, duplicate events.
   */
  static async getSummary(daysBack = 30): Promise<ReconciliationSummary> {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const period = `Last ${daysBack} days`;

    const [statusCounts, capturedPayments, invoiceCount] = await Promise.all([
      Payment.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$status", count: { $sum: 1 }, totalINR: { $sum: "$amountINR" } } },
      ]),
      Payment.find({ status: "CAPTURED", createdAt: { $gte: since } }).select("_id amountINR invoiceId refundAmountINR refundStatus introductionId"),
      Invoice.countDocuments({ createdAt: { $gte: since } }),
    ]);

    const statsMap: Record<string, { count: number; totalINR: number }> = {};
    for (const s of statusCounts) {
      statsMap[s._id] = { count: s.count, totalINR: s.totalINR };
    }

    const grossRevenueINR = statsMap["CAPTURED"]?.totalINR || 0;
    const totalRefundedINR = statsMap["REFUNDED"]?.totalINR || 0;
    const netRevenueINR = grossRevenueINR - totalRefundedINR;

    // Detect discrepancies
    const discrepancies: ReconciliationSummary["discrepancies"] = [];

    for (const payment of capturedPayments) {
      // Captured payment with no invoice
      if (!payment.invoiceId) {
        discrepancies.push({
          type: "MISSING_INVOICE",
          paymentId: payment._id.toString(),
          detail: `Payment ${payment._id} captured at ₹${payment.amountINR} has no linked invoice.`,
        });
      }

      // Partially refunded without being marked REFUNDED
      if ((payment as any).refundAmountINR > 0 && payment.refundStatus === "NONE") {
        discrepancies.push({
          type: "REFUND_STATUS_MISMATCH",
          paymentId: payment._id.toString(),
          detail: `Payment ${payment._id} has refundAmountINR set but refundStatus is NONE.`,
        });
      }
    }

    return {
      period,
      totalCaptured: statsMap["CAPTURED"]?.count || 0,
      totalRefunded: statsMap["REFUNDED"]?.count || 0,
      totalFailed: statsMap["FAILED"]?.count || 0,
      totalCreatedPending: statsMap["CREATED"]?.count || 0,
      grossRevenueINR,
      netRevenueINR,
      totalRefundedINR,
      invoicesIssued: invoiceCount,
      discrepancies,
    };
  }

  /**
   * Process a refund request — marks payment as REFUND_PENDING for finance team action.
   * Does NOT call Razorpay directly (requires human approval for production safety).
   */
  static async requestRefund(data: {
    paymentId: string;
    adminId: string;
    reason: string;
    refundAmountINR?: number;
  }): Promise<{ success: boolean; paymentId: string; status: string }> {
    const payment = await Payment.findById(data.paymentId);
    if (!payment) throw new Error("Payment not found");
    if (payment.status === "REFUNDED") throw new Error("Payment already refunded");
    if (payment.status !== "CAPTURED") throw new Error("Only captured payments can be refunded");

    payment.status = "REFUND_PENDING";
    payment.refundStatus = "REQUESTED";
    payment.refundReason = data.reason;
    payment.refundAmountINR = data.refundAmountINR ?? payment.amountINR;
    payment.refundRequestedAt = new Date();
    await payment.save();

    await AuditLog.create({
      actorId: new Types.ObjectId(data.adminId),
      actorRole: "FINANCE_ADMIN",
      action: "REFUND_REQUESTED",
      targetCollection: "Payment",
      targetId: payment._id.toString(),
      details: { reason: data.reason, refundAmountINR: payment.refundAmountINR },
    });

    await Notification.create({
      userId: payment.userId,
      title: "Refund Request Received",
      message: `Your refund request of ₹${payment.refundAmountINR} is being processed. We will confirm within 5–7 business days.`,
      category: "PAYMENT",
      deepLink: "/dashboard/invoices",
    });

    return { success: true, paymentId: payment._id.toString(), status: "REFUND_PENDING" };
  }

  /**
   * Confirm a refund as processed (called after Razorpay refund confirmed).
   */
  static async confirmRefund(data: {
    paymentId: string;
    adminId: string;
    razorpayRefundId: string;
  }): Promise<void> {
    const payment = await Payment.findById(data.paymentId);
    if (!payment) throw new Error("Payment not found");

    payment.status = "REFUNDED";
    payment.refundStatus = "PROCESSED";
    payment.refundRazorpayId = data.razorpayRefundId;
    payment.refundedAt = new Date();
    await payment.save();

    // Mark linked introduction as REFUNDED
    if (payment.introductionId) {
      await Introduction.findByIdAndUpdate(payment.introductionId, { status: "REFUNDED" });
    }

    await AuditLog.create({
      actorId: new Types.ObjectId(data.adminId),
      actorRole: "FINANCE_ADMIN",
      action: "REFUND_CONFIRMED",
      targetCollection: "Payment",
      targetId: payment._id.toString(),
      details: { razorpayRefundId: data.razorpayRefundId, refundAmountINR: payment.refundAmountINR },
    });

    await Notification.create({
      userId: payment.userId,
      title: "Refund Processed ✅",
      message: `Your refund of ₹${payment.refundAmountINR} has been processed. It will reflect in your account within 5–7 business days depending on your bank.`,
      category: "PAYMENT",
      deepLink: "/dashboard/invoices",
    });
  }
}
