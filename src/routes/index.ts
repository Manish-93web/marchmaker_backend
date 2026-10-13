import { Router } from "express";
import authRoutes from "./authRoutes.js";
import profileRoutes from "./profileRoutes.js";
import preferenceRoutes from "./preferenceRoutes.js";
import assessmentRoutes from "./assessmentRoutes.js";
import verificationRoutes from "./verificationRoutes.js";
import introductionRoutes from "./introductionRoutes.js";
import paymentRoutes from "./paymentRoutes.js";
import walletRoutes from "./walletRoutes.js";
import moderationRoutes from "./moderationRoutes.js";
import supportRoutes from "./supportRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import privacyRoutes from "./privacyRoutes.js";
import adminRoutes from "./adminRoutes.js";
import journeyRoutes from "./journeyRoutes.js";
import whatsappRoutes from "./whatsappRoutes.js";
import eGuideRoutes from "./eGuideRoutes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/preferences", preferenceRoutes);
router.use("/assessment", assessmentRoutes);
router.use("/verification", verificationRoutes);
router.use("/introductions", introductionRoutes);
router.use("/payments", paymentRoutes);
router.use("/wallet", walletRoutes);
router.use("/moderation", moderationRoutes);
router.use("/support", supportRoutes);
router.use("/notifications", notificationRoutes);
router.use("/privacy", privacyRoutes);
router.use("/admin", adminRoutes);
router.use("/member/journey-status", journeyRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/guides", eGuideRoutes);

export default router;

