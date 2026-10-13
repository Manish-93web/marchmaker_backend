import { Router, Request, Response } from "express";
import { z } from "zod";
import { EGuideService } from "../services/eGuideService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

// GET /guides — List all guides (public or authenticated with progress)
router.get("/", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let userId: string | undefined;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const jwt = await import("jsonwebtoken");
        const { config } = await import("../config/index.js");
        const decoded = jwt.default.verify(token, config.jwtSecret) as any;
        userId = decoded.userId;
      } catch (e) {
        // Continue as unauthenticated
      }
    }

    const guides = await EGuideService.getAllGuides(userId);
    res.json({ success: true, data: guides });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /guides/:slug — Get single guide
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let userId: string | undefined;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const jwt = await import("jsonwebtoken");
        const { config } = await import("../config/index.js");
        const decoded = jwt.default.verify(token, config.jwtSecret) as any;
        userId = decoded.userId;
      } catch (e) {}
    }

    const result = await EGuideService.getGuideBySlug(req.params.slug, userId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(404).json({ success: false, message: error.message });
  }
});

// POST /guides/progress — Save audio playback position / completion
const progressSchema = z.object({
  guideId: z.string().min(1),
  playbackPositionSeconds: z.number().min(0),
  isCompleted: z.boolean().optional(),
});

router.post("/progress", authenticate, validateBody(progressSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const progress = await EGuideService.updateProgress({
      userId: req.userId!,
      ...req.body,
    });
    res.json({ success: true, data: progress });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
