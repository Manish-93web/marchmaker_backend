import { Router, Response } from "express";
import { z } from "zod";
import { AdminService } from "../services/adminService.js";
import { ReviewService } from "../services/reviewService.js";
import { VerificationService } from "../services/verificationService.js";
import { ModerationService } from "../services/moderationService.js";
import { SupportService } from "../services/supportService.js";
import { PaymentService } from "../services/paymentService.js";
import { FeedbackService } from "../services/feedbackService.js";
import { ReconciliationService } from "../services/reconciliationService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

// All admin routes require staff authentication
const STAFF_ROLES = ["SUPER_ADMIN", "REVIEWER", "MODERATOR", "SUPPORT_AGENT", "FINANCE_ADMIN"] as any;

router.use(authenticate);
router.use(requireRole(STAFF_ROLES));

// 1. Overview Platform Metrics
router.get("/stats", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stats = await AdminService.getPlatformStats();
    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 2. Members Management
router.get("/members", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const search = req.query.search as string;
    const isSuspended = req.query.isSuspended ? req.query.isSuspended === "true" : undefined;

    const data = await AdminService.listMembers({ page, limit, search, isSuspended });
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 3. Human Review Queue for Matchmaking Introductions
router.get("/reviews", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 10;
    const data = await ReviewService.getPendingReviews(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const reviewDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  notes: z.string().optional(),
});

router.post("/reviews/:id/decision", validateBody(reviewDecisionSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const intro = await ReviewService.reviewIntroduction({
      introductionId: req.params.id,
      reviewerId: req.userId!,
      decision: req.body.decision,
      notes: req.body.notes,
    });
    res.json({
      success: true,
      message: `Introduction ${req.body.decision === "APPROVE" ? "approved and offered to members" : "rejected"}`,
      data: intro,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 4. KYC Identity Verifications Queue
router.get("/verifications", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const data = await VerificationService.getPendingRequests(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const verificationDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFO"]),
  reason: z.string().optional(),
});

router.post("/verifications/:id/decision", validateBody(verificationDecisionSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await VerificationService.reviewRequest({
      requestId: req.params.id,
      reviewerId: req.userId!,
      decision: req.body.decision,
      reason: req.body.reason,
    });
    res.json({
      success: true,
      message: `Verification decision recorded: ${req.body.decision}`,
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 5. Moderation Queue & Reports
router.get("/reports", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const data = await ModerationService.getPendingReports(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const actionReportSchema = z.object({
  action: z.enum(["NO_ACTION", "WARNING_ISSUED", "PROFILE_SUSPENDED", "PERMANENT_BAN"]),
  moderatorNotes: z.string().optional(),
});

router.post("/reports/:id/action", validateBody(actionReportSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const report = await ModerationService.actionReport({
      reportId: req.params.id,
      moderatorId: req.userId!,
      action: req.body.action,
      moderatorNotes: req.body.moderatorNotes,
    });
    res.json({
      success: true,
      message: "Moderation action applied successfully",
      data: report,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 6. Support Desk Operations
router.get("/support/tickets", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const data = await SupportService.getAllTickets(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const supportReplySchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
});

router.post("/support/tickets/:id/reply", validateBody(supportReplySchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await SupportService.replyToTicket({
      ticketId: req.params.id,
      senderId: req.userId!,
      senderRole: req.userRole || "SUPPORT_AGENT",
      message: req.body.message,
    });
    res.json({
      success: true,
      message: "Reply sent to member",
      data: ticket,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch("/support/tickets/:id/status", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = req.body.status;
    const ticket = await SupportService.updateTicketStatus(req.params.id, status);
    res.json({
      success: true,
      message: "Ticket status updated",
      data: ticket,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 7. Finance & Transaction Audits
router.get("/payments", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const data = await PaymentService.getAllPayments(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 8. Immutable System Audit Logs
router.get("/audit-logs", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const data = await AdminService.getAuditLogs(page, limit);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────
// 9. REVIEWER OPERATIONS & QUALITY CONTROLS
// ─────────────────────────────────────────────────────

// Reviewer workload stats
router.get("/reviewer-stats", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await ReviewService.getReviewerStats();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Prioritised review queue
router.get("/reviews/queue", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const priority = req.query.priority as string | undefined;
    const data = await ReviewService.getPendingReviews(page, 10, priority);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Escalate a review
const escalateSchema = z.object({
  reason: z.string().min(10, "Escalation reason must be at least 10 characters"),
});

router.post("/reviews/:id/escalate", validateBody(escalateSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const intro = await ReviewService.escalateReview({
      introductionId: req.params.id,
      escalatedByReviewerId: req.userId!,
      reason: req.body.reason,
    });
    res.json({ success: true, message: "Introduction escalated for senior review", data: intro });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Set review priority
const prioritySchema = z.object({
  priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
});

router.patch("/reviews/:id/priority", validateBody(prioritySchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ReviewService.setPriority(req.params.id, req.body.priority);
    res.json({ success: true, message: "Review priority updated" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────
// 10. MATCH-QUALITY FEEDBACK ANALYTICS
// ─────────────────────────────────────────────────────

router.get("/feedback-analytics", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const daysBack = parseInt(req.query.days as string, 10) || 90;
    const data = await FeedbackService.getAnalytics(daysBack);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────
// 11. FINANCIAL RECONCILIATION
// ─────────────────────────────────────────────────────

router.get("/payments/reconciliation", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const daysBack = parseInt(req.query.days as string, 10) || 30;
    const data = await ReconciliationService.getSummary(daysBack);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const refundRequestSchema = z.object({
  reason: z.string().min(10, "Reason must be at least 10 characters"),
  refundAmountINR: z.number().positive().optional(),
});

router.post("/payments/:id/refund", validateBody(refundRequestSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await ReconciliationService.requestRefund({
      paymentId: req.params.id,
      adminId: req.userId!,
      reason: req.body.reason,
      refundAmountINR: req.body.refundAmountINR,
    });
    res.json({ success: true, message: "Refund request recorded and member notified", data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const confirmRefundSchema = z.object({
  razorpayRefundId: z.string().min(5),
});

router.post("/payments/:id/confirm-refund", validateBody(confirmRefundSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ReconciliationService.confirmRefund({
      paymentId: req.params.id,
      adminId: req.userId!,
      razorpayRefundId: req.body.razorpayRefundId,
    });
    res.json({ success: true, message: "Refund confirmed and member notified" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
