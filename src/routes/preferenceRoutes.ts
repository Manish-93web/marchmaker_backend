import { Router, Response } from "express";
import { PreferenceService } from "../services/preferenceService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const preferences = await PreferenceService.getPreferences(req.userId!);
    res.json({ success: true, data: preferences });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const preferences = await PreferenceService.updatePreferences(req.userId!, req.body);
    res.json({
      success: true,
      message: "Preferences updated successfully",
      data: preferences,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
