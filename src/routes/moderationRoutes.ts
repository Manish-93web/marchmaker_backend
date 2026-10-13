import { Router, Response } from "express";
import { z } from "zod";
import { ModerationService } from "../services/moderationService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

const reportSchema = z.object({
  reportedUserId: z.string(),
  introductionId: z.string().optional(),
  reason: z.string().min(1, "Reason is required"),
  details: z.string().min(5, "Details are required"),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

router.post("/report", authenticate, validateBody(reportSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const report = await ModerationService.reportUser({
      reporterId: req.userId!,
      ...req.body,
    });
    res.status(201).json({
      success: true,
      message: "Report submitted. The member has also been blocked for your safety.",
      data: report,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const blockSchema = z.object({
  blockedUserId: z.string(),
});

router.post("/block", authenticate, validateBody(blockSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ModerationService.blockUser(req.userId!, req.body.blockedUserId);
    res.json({
      success: true,
      message: "Member successfully blocked.",
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
