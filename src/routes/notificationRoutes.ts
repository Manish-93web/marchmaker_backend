import { Router, Response } from "express";
import { NotificationService } from "../services/notificationService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await NotificationService.getNotificationsForUser(req.userId!);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.patch("/:id/read", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await NotificationService.markAsRead(req.params.id, req.userId!);
    res.json({ success: true, message: "Marked as read" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/read-all", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await NotificationService.markAllAsRead(req.userId!);
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
