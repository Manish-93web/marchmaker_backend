import { Router, Response } from "express";
import { z } from "zod";
import { SupportService } from "../services/supportService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.get("/tickets", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tickets = await SupportService.getTicketsForUser(req.userId!);
    res.json({ success: true, data: tickets });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const createTicketSchema = z.object({
  subject: z.string().min(5, "Subject must be at least 5 characters"),
  category: z.enum(["PROFILE", "VERIFICATION", "INTRODUCTION", "PAYMENT", "PRIVACY", "OTHER"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  initialMessage: z.string().min(10, "Please describe your question or issue in detail"),
});

router.post("/tickets", authenticate, validateBody(createTicketSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await SupportService.createTicket({
      userId: req.userId!,
      ...req.body,
    });
    res.status(201).json({
      success: true,
      message: "Support ticket created",
      data: ticket,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const replySchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
});

router.post("/tickets/:id/messages", authenticate, validateBody(replySchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await SupportService.replyToTicket({
      ticketId: req.params.id,
      senderId: req.userId!,
      senderRole: req.userRole || "MEMBER",
      message: req.body.message,
    });
    res.json({
      success: true,
      message: "Message sent",
      data: ticket,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
