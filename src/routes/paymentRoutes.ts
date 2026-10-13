import { Router, Response } from "express";
import { z } from "zod";
import { PaymentService } from "../services/paymentService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

const createOrderSchema = z.object({
  introductionId: z.string(),
  idempotencyKey: z.string().optional(),
});

router.post("/create-order", authenticate, validateBody(createOrderSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const order = await PaymentService.createOrder({
      userId: req.userId!,
      introductionId: req.body.introductionId,
      idempotencyKey: req.body.idempotencyKey,
    });
    res.json({
      success: true,
      data: order,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const verifySchema = z.object({
  introductionId: z.string(),
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string(),
  razorpaySignature: z.string(),
});

router.post("/verify", authenticate, validateBody(verifySchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await PaymentService.verifyPayment({
      userId: req.userId!,
      ...req.body,
    });
    res.json({
      success: true,
      message: "Payment verified and introduction unlocked successfully",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/invoices", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const invoices = await PaymentService.getInvoicesForUser(req.userId!);
    res.json({ success: true, data: invoices });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/webhook", async (req: any, res: Response) => {
  try {
    const signature = (req.headers["x-razorpay-signature"] as string) || "";
    const result = await PaymentService.handleWebhook(req.body, signature);
    res.json(result);
  } catch (error: any) {
    console.error("[Webhook Error]", error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
