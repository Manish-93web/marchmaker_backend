import { Router, Response } from "express";
import { z } from "zod";
import { ProfileService } from "../services/profileService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await ProfileService.getProfileByUserId(req.userId!);
    res.json({ success: true, data: profile });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const draftSchema = z.object({
  step: z.number().min(1).max(5),
  data: z.record(z.any()),
});

router.patch("/draft", authenticate, validateBody(draftSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await ProfileService.saveDraft(req.userId!, req.body.step, req.body.data);
    res.json({
      success: true,
      message: "Draft autosaved successfully",
      data: profile,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/submit", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await ProfileService.submitProfile(req.userId!);
    res.json({
      success: true,
      message: "Profile submitted successfully",
      data: profile,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const photoSchema = z.object({
  url: z.string().url("Valid image URL required"),
  isPrivate: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

router.post("/photos", authenticate, validateBody(photoSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await ProfileService.addPhoto(req.userId!, req.body);
    res.json({
      success: true,
      message: "Photo uploaded successfully",
      data: profile,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete("/photos/:photoId", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await ProfileService.deletePhoto(req.userId!, req.params.photoId);
    res.json({
      success: true,
      message: "Photo removed",
      data: profile,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const presignedSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().min(1),
});

router.post("/photos/presigned-upload", authenticate, validateBody(presignedSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { StorageService } = await import("../services/storageService.js");
    const result = StorageService.generatePresignedUploadUrl({
      userId: req.userId!,
      category: "PROFILE_PHOTO",
      fileName: req.body.fileName,
      contentType: req.body.contentType,
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;

