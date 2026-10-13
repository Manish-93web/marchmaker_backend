import nodemailer, { Transporter } from "nodemailer";
import { config } from "../config/index.js";
import { NotificationDeliveryAttempt } from "../models/NotificationDeliveryAttempt.js";

export class EmailService {
  private static transporter: Transporter | null = null;

  private static getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpPort === 465,
        auth: {
          user: config.email.smtpUser,
          pass: config.email.smtpPass,
        },
      });
    }
    return this.transporter;
  }

  private static wrapTemplate(title: string, bodyContent: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fdf8f6; color: #1f2937; margin: 0; padding: 24px; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #fee2e2; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); }
    .header { text-align: center; border-bottom: 1px solid #fecdd3; padding-bottom: 20px; margin-bottom: 24px; }
    .brand { color: #9f1239; font-size: 24px; font-weight: bold; letter-spacing: -0.5px; }
    .subbrand { color: #9ca3af; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
    .content { font-size: 15px; line-height: 1.6; color: #374151; }
    .button { display: inline-block; background: #9f1239; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-weight: 600; margin-top: 20px; font-size: 14px; }
    .footer { text-align: center; margin-top: 32px; font-size: 12px; color: #9ca3af; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand">Marchmaker</div>
      <div class="subbrand">Curated Matrimonial Matchmaking</div>
    </div>
    <div class="content">
      ${bodyContent}
    </div>
    <div class="footer">
      <p>Marchmaker Private Limited · Trust, Privacy & Culturally Aware Introductions</p>
      <p>This email was sent in compliance with the Digital Personal Data Protection Act 2023.</p>
    </div>
  </div>
</body>
</html>`;
  }

  static async sendMail(options: {
    to: string;
    subject: string;
    html: string;
    template: string;
    recipientUserId?: any;
    metadata?: Record<string, any>;
  }): Promise<boolean> {
    const attempt = new NotificationDeliveryAttempt({
      recipient: options.to,
      recipientUserId: options.recipientUserId,
      channel: "EMAIL",
      template: options.template,
      provider: "Nodemailer/SMTP",
      status: "PENDING",
      metadata: options.metadata,
    });

    try {
      const transporter = this.getTransporter();
      const info = await transporter.sendMail({
        from: config.email.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      });

      attempt.status = "DELIVERED";
      attempt.providerMessageId = info.messageId;
      await attempt.save();
      console.log(`[EmailService] Sent '${options.template}' to ${options.to} (ID: ${info.messageId})`);
      return true;
    } catch (error: any) {
      attempt.status = "FAILED";
      attempt.errorMessage = error.message || "Unknown SMTP error";
      await attempt.save();
      console.warn(`[EmailService] Simulated/Fallback for '${options.template}' to ${options.to}: ${error.message}`);
      // Do not throw to avoid crashing core business logic when SMTP is not configured
      return false;
    }
  }

  static async sendWelcomeEmail(to: string, fullName: string, token: string) {
    const link = `${config.frontendUrl}/verify-email?token=${token}`;
    const body = `
      <h2>Namaste ${fullName}, Welcome to Marchmaker</h2>
      <p>We are delighted to welcome you to India's privacy-first, human-curated matchmaking platform.</p>
      <p>Every introduction on Marchmaker is reviewed by an experienced human matchmaker to ensure mutual alignment in values, goals, and lifestyle.</p>
      <p>Please confirm your email address to begin your guided profile creation:</p>
      <div style="text-align: center;">
        <a href="${link}" class="button">Verify Email Address</a>
      </div>
      <p style="margin-top: 24px; font-size: 13px; color: #6b7280;">If the button does not work, copy this link into your browser: <br/>${link}</p>
    `;
    return this.sendMail({
      to,
      subject: "Welcome to Marchmaker — Confirm Your Email",
      html: this.wrapTemplate("Welcome to Marchmaker", body),
      template: "WELCOME_EMAIL",
    });
  }

  static async sendKycStatusEmail(to: string, fullName: string, status: "APPROVED" | "REJECTED" | "ACTION_REQUIRED", notes?: string) {
    const title = status === "APPROVED" ? "Identity Verified Successfully" : "KYC Verification Update";
    const body = `
      <h2>Hello ${fullName},</h2>
      <p>Your identity verification documents have been reviewed by our compliance team.</p>
      <p><strong>Status:</strong> <span style="color: ${status === "APPROVED" ? "#047857" : "#b91c1c"}">${status}</span></p>
      ${notes ? `<p><strong>Notes from Reviewer:</strong> ${notes}</p>` : ""}
      <div style="text-align: center;">
        <a href="${config.frontendUrl}/dashboard/verification" class="button">View Verification Status</a>
      </div>
    `;
    return this.sendMail({
      to,
      subject: `Marchmaker KYC Verification: ${status}`,
      html: this.wrapTemplate(title, body),
      template: "KYC_STATUS_UPDATE",
    });
  }

  static async sendIntroductionOfferedEmail(to: string, fullName: string, introId: string) {
    const body = `
      <h2>Hello ${fullName},</h2>
      <p>Our matchmakers have prepared a new, carefully reviewed introduction for you.</p>
      <p>This profile was selected based on your shared life goals, relationship values, and mutual preferences.</p>
      <div style="text-align: center;">
        <a href="${config.frontendUrl}/dashboard/introductions" class="button">Review Your Introduction</a>
      </div>
    `;
    return this.sendMail({
      to,
      subject: "A New Curated Introduction Awaits You on Marchmaker",
      html: this.wrapTemplate("New Introduction Available", body),
      template: "INTRODUCTION_OFFERED",
      metadata: { introId },
    });
  }

  static async sendMatchAcceptedEmail(to: string, fullName: string, matchName: string) {
    const body = `
      <h2>Great News, ${fullName}!</h2>
      <p>Both you and <strong>${matchName}</strong> have accepted the introduction!</p>
      <p>You can now view their unlocked contact details and initiate your first conversation.</p>
      <div style="text-align: center;">
        <a href="${config.frontendUrl}/dashboard/introductions" class="button">Connect with ${matchName}</a>
      </div>
    `;
    return this.sendMail({
      to,
      subject: `Mutual Acceptance: Connect with ${matchName}`,
      html: this.wrapTemplate("Mutual Match Accepted", body),
      template: "MATCH_ACCEPTED",
    });
  }

  static async sendPaymentReceiptEmail(to: string, fullName: string, amountINR: number, invoiceNumber: string) {
    const body = `
      <h2>Payment Confirmation</h2>
      <p>Dear ${fullName}, thank you for your payment.</p>
      <p>Your introduction unlock has been successfully activated.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Invoice Number:</td><td style="padding: 8px 0; font-weight: bold; text-align: right;">${invoiceNumber}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Amount Paid:</td><td style="padding: 8px 0; font-weight: bold; text-align: right;">₹${amountINR.toLocaleString("en-IN")}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">GST (18% Included):</td><td style="padding: 8px 0; text-align: right;">₹${((amountINR * 18) / 118).toFixed(2)}</td></tr>
      </table>
      <div style="text-align: center;">
        <a href="${config.frontendUrl}/dashboard/invoices" class="button">Download GST Invoice</a>
      </div>
    `;
    return this.sendMail({
      to,
      subject: `Marchmaker Invoice ${invoiceNumber} — Payment Receipt`,
      html: this.wrapTemplate("Payment Receipt", body),
      template: "PAYMENT_RECEIPT",
      metadata: { invoiceNumber, amountINR },
    });
  }

  static async sendPasswordResetEmail(to: string, fullName: string, token: string) {
    const link = `${config.frontendUrl}/reset-password?token=${token}`;
    const body = `
      <h2>Password Reset Request</h2>
      <p>Hello ${fullName}, we received a request to reset your password on Marchmaker.</p>
      <p>Click the button below within 1 hour to set a new password:</p>
      <div style="text-align: center;">
        <a href="${link}" class="button">Reset Password</a>
      </div>
      <p style="margin-top: 24px; font-size: 13px; color: #6b7280;">If you did not request this, you can safely ignore this email.</p>
    `;
    return this.sendMail({
      to,
      subject: "Marchmaker Password Reset Request",
      html: this.wrapTemplate("Password Reset", body),
      template: "PASSWORD_RESET",
    });
  }
}
