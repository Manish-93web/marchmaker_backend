import { Router, Response } from "express";
import { z } from "zod";
import { PrivacyService } from "../services/privacyService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.get("/export", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await PrivacyService.exportUserData(req.userId!);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const deleteSchema = z.object({
  reason: z.string().optional(),
});

router.post("/delete-request", authenticate, validateBody(deleteSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await PrivacyService.requestDataDeletion(req.userId!, req.body.reason);
    res.status(201).json({
      success: true,
      message: "Data deletion request recorded. Per DPDP Act, your account and personal records will be securely purged after the 30-day grace period.",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const consentSchema = z.object({
  termsAccepted: z.boolean(),
  privacyPolicyAccepted: z.boolean(),
  dpdpConsentAccepted: z.boolean(),
  matchmakingConsentAccepted: z.boolean(),
});

router.post("/consent", authenticate, validateBody(consentSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await PrivacyService.recordConsent({
      userId: req.userId!,
      ...req.body,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({
      success: true,
      message: "Consent record saved successfully",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
