import crypto from "crypto";
import { Types } from "mongoose";
import { config } from "../config/index.js";
import { Payment, IPayment } from "../models/Payment.js";
import { Invoice } from "../models/Invoice.js";
import { Introduction } from "../models/Introduction.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { AuditLog } from "../models/AuditLog.js";

export class PaymentService {
  /**
   * Creates an order for unlocking an introduction
   */
  static async createOrder(data: {
    userId: string;
    introductionId: string;
    idempotencyKey?: string;
  }): Promise<{ orderId: string; amount: number; currency: string; keyId: string }> {
    const intro = await Introduction.findById(data.introductionId);
    if (!intro) {
      throw new Error("Introduction not found");
    }

    const isMember1 = intro.member1Id.toString() === data.userId;
    const isMember2 = intro.member2Id.toString() === data.userId;
    if (!isMember1 && !isMember2) {
      throw new Error("Unauthorized");
    }

    const isAlreadyUnlocked = isMember1 ? intro.member1Unlocked : intro.member2Unlocked;
    if (isAlreadyUnlocked) {
      throw new Error("This introduction has already been unlocked.");
    }

    const idempotencyKey =
      data.idempotencyKey || `order_${data.userId}_${data.introductionId}_${Date.now()}`;

    // Check existing order with idempotency key
    const existingPayment = await Payment.findOne({ idempotencyKey });
    if (existingPayment && existingPayment.status === "CREATED") {
      return {
        orderId: existingPayment.razorpayOrderId,
        amount: existingPayment.amountINR * 100, // paisa
        currency: "INR",
        keyId: config.razorpay.keyId,
      };
    }

    const amountINR = config.razorpay.introductionFeeINR; // ₹499
    // Simulated or Live Razorpay Order ID format: order_Kz...
    const simulatedOrderId = `order_${crypto.randomBytes(8).toString("hex")}`;

    await Payment.create({
      userId: new Types.ObjectId(data.userId),
      introductionId: new Types.ObjectId(data.introductionId),
      razorpayOrderId: simulatedOrderId,
      amountINR,
      currency: "INR",
      status: "CREATED",
      idempotencyKey,
    });

    return {
      orderId: simulatedOrderId,
      amount: amountINR * 100, // in paise
      currency: "INR",
      keyId: config.razorpay.keyId,
    };
  }

  /**
   * Verifies payment via HMAC SHA256 signature and unlocks introduction
   */
  static async verifyPayment(data: {
    userId: string;
    introductionId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): Promise<{ success: boolean; invoiceNumber?: string }> {
    const payment = await Payment.findOne({ razorpayOrderId: data.razorpayOrderId });
    if (!payment) {
      throw new Error("Payment record not found");
    }

    if (payment.status === "CAPTURED") {
      // Idempotent response
      return { success: true };
    }

    // Verify HMAC signature in production or sandbox
    const generatedSignature = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${data.razorpayOrderId}|${data.razorpayPaymentId}`)
      .digest("hex");

    // In local development or test mode, accept simulated signature if matches or if development/test
    const isValidSignature =
      config.nodeEnv === "development" ||
      config.nodeEnv === "test" ||
      generatedSignature === data.razorpaySignature;

    if (!isValidSignature) {
      payment.status = "FAILED";
      payment.failureReason = "Invalid payment signature";
      await payment.save();
      throw new Error("Invalid payment signature verification failed");
    }

    payment.status = "CAPTURED";
    payment.razorpayPaymentId = data.razorpayPaymentId;
    payment.razorpaySignature = data.razorpaySignature;

    // Calculate GST breakdown: ₹499 total = Base ₹422.88 + CGST 9% (₹38.06) + SGST 9% (₹38.06)
    const totalINR = payment.amountINR;
    const baseINR = Number((totalINR / 1.18).toFixed(2));
    const taxEach = Number(((totalINR - baseINR) / 2).toFixed(2));

    const invoiceNumber = `INV-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;

    const user = await User.findById(data.userId);

    const invoice = await Invoice.create({
      invoiceNumber,
      userId: payment.userId,
      paymentId: payment._id,
      introductionId: payment.introductionId,
      billingName: user?.fullName || "Member",
      billingEmail: user?.email || "",
      billingState: "Delhi",
      baseAmountINR: baseINR,
      cgstAmountINR: taxEach,
      sgstAmountINR: taxEach,
      totalAmountINR: totalINR,
      sacCode: "998399",
      invoiceDate: new Date(),
    });

    payment.invoiceId = invoice._id;
    await payment.save();

    // Unlock Introduction
    const intro = await Introduction.findById(data.introductionId);
    if (intro) {
      const isMember1 = intro.member1Id.toString() === data.userId;
      if (isMember1) {
        intro.member1Unlocked = true;
        intro.member1PaymentId = payment._id;
      } else {
        intro.member2Unlocked = true;
        intro.member2PaymentId = payment._id;
      }
      if (intro.status === "OFFERED" || intro.status === "PAYMENT_PENDING") {
        intro.status = "UNLOCKED";
      }
      await intro.save();
    }

    // Notifications
    await Notification.create({
      userId: payment.userId,
      title: "Introduction Unlocked! 🔓",
      message: `Payment of ₹${totalINR} received. Full profile details and introductory notes are now accessible. Invoice #${invoiceNumber}.`,
      category: "PAYMENT",
      deepLink: "/dashboard/introductions",
    });

    // Audit log
    await AuditLog.create({
      actorId: new Types.ObjectId(data.userId),
      actorRole: "MEMBER",
      action: "PAYMENT_CAPTURED",
      targetCollection: "Payment",
      targetId: payment._id.toString(),
      details: { amountINR: totalINR, invoiceNumber },
    });

    try {
      const { EmailService } = await import("./emailService.js");
      if (user?.email) {
        await EmailService.sendPaymentReceiptEmail(user.email, user.fullName, totalINR, invoiceNumber);
      }
    } catch (e) {
      console.warn("[PaymentService] Email dispatch warning:", e);
    }

    return { success: true, invoiceNumber };
  }

  static async getInvoicesForUser(userId: string) {
    return Invoice.find({ userId }).sort({ createdAt: -1 });
  }

  static async getAllPayments(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [payments, total] = await Promise.all([
      Payment.find()
        .populate("userId", "fullName email")
        .populate("invoiceId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Payment.countDocuments(),
    ]);

    return { payments, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Idempotently process Razorpay webhook notifications
   */
  static async handleWebhook(rawBody: any, signature: string): Promise<{ success: boolean; event: string }> {
    const payloadStr = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
    const expectedSignature = crypto
      .createHmac("sha256", config.razorpay.webhookSecret)
      .update(payloadStr)
      .digest("hex");

    const isValid =
      config.nodeEnv === "development" ||
      config.nodeEnv === "test" ||
      signature === expectedSignature;

    if (!isValid) {
      throw new Error("Invalid Razorpay webhook signature");
    }

    const payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const event = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;

    if (event === "payment.captured" && paymentEntity?.order_id) {
      const payment = await Payment.findOne({ razorpayOrderId: paymentEntity.order_id });
      if (payment && payment.status !== "CAPTURED") {
        await this.verifyPayment({
          userId: payment.userId.toString(),
          introductionId: payment.introductionId.toString(),
          razorpayOrderId: paymentEntity.order_id,
          razorpayPaymentId: paymentEntity.id,
          razorpaySignature: signature || "webhook_verified",
        });
      }
    } else if (event === "payment.failed" && paymentEntity?.order_id) {
      await Payment.updateOne(
        { razorpayOrderId: paymentEntity.order_id },
        { status: "FAILED", failureReason: paymentEntity.error_description || "Payment failed at gateway" }
      );
    }

    return { success: true, event: event || "processed" };
  }
}
