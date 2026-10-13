import { Router, Response } from "express";
import { z } from "zod";
import { VerificationService } from "../services/verificationService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

const kycSchema = z.object({
  documentType: z.enum(["AADHAAR", "PASSPORT", "VOTER_ID", "DRIVING_LICENSE"]),
  documentNumber: z.string().min(4, "Document number required"),
  documentUrl: z.string().min(1, "Document upload required"),
  selfieUrl: z.string().min(1, "Selfie upload required"),
});

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const request = await VerificationService.getLatestByUser(req.userId!);
    res.json({ success: true, data: request });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/submit", authenticate, validateBody(kycSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const request = await VerificationService.submitRequest({
      userId: req.userId!,
      ...req.body,
    });
    res.status(201).json({
      success: true,
      message: "Verification documents submitted successfully",
      data: request,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Automated Document Check (Verhoeff Aadhaar, MRZ Passport, EPIC Voter ID)
const validateDocSchema = z.object({
  documentType: z.enum(["AADHAAR", "PASSPORT", "VOTER_ID", "DRIVING_LICENSE"]),
  documentNumber: z.string().min(4),
});

router.post("/validate-document", authenticate, validateBody(validateDocSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { AutomatedKycService } = await import("../services/automatedKycService.js");
    const result = AutomatedKycService.validateDocument(req.body.documentType, req.body.documentNumber);
    if (!result.isValid) {
      return res.status(400).json({ success: false, message: result.error });
    }
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Interactive Liveness Challenge
router.post("/liveness/start", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { AutomatedKycService } = await import("../services/automatedKycService.js");
    const challenge = AutomatedKycService.startLivenessChallenge(req.userId!);
    res.json({ success: true, data: challenge });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const verifyLivenessSchema = z.object({
  sessionId: z.string().min(1),
  completedActions: z.array(z.string()).min(1),
  selfieImageBase64: z.string().optional(),
});

router.post("/liveness/verify", authenticate, validateBody(verifyLivenessSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { AutomatedKycService } = await import("../services/automatedKycService.js");
    const result = AutomatedKycService.verifyLivenessChallenge({
      sessionId: req.body.sessionId,
      userId: req.userId!,
      completedActions: req.body.completedActions,
      selfieImageBase64: req.body.selfieImageBase64,
    });
    res.json({ success: result.isPassed, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const kycPresignedSchema = z.object({
  category: z.enum(["KYC_DOCUMENT", "SELFIE"]),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
});

router.post("/presigned-upload", authenticate, validateBody(kycPresignedSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { StorageService } = await import("../services/storageService.js");
    const result = StorageService.generatePresignedUploadUrl({
      userId: req.userId!,
      category: req.body.category,
      fileName: req.body.fileName,
      contentType: req.body.contentType,
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;


