import { Router, Request, Response } from "express";
import { WhatsAppService } from "../services/whatsappService.js";

const router = Router();

// GET /whatsapp/webhook — Meta Challenge Verification
router.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  const verifiedChallenge = WhatsAppService.verifyWebhook(mode, token, challenge);
  if (verifiedChallenge) {
    res.status(200).send(verifiedChallenge);
  } else {
    res.status(403).json({ success: false, message: "Verification failed" });
  }
});

// POST /whatsapp/webhook — Incoming Delivery Receipts & Status
router.post("/webhook", async (req: Request, res: Response) => {
  await WhatsAppService.handleWebhookEvent(req.body);
  res.status(200).json({ status: "EVENT_RECEIVED" });
});

export default router;
