import { Router, Request, Response } from "express";
import { z } from "zod";
import { AuthService } from "../services/authService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  fullName: z.string().min(2, "Full name must be at least 2 characters"),
  phone: z.string().optional(),
  referredByCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

router.post("/register", validateBody(registerSchema), async (req: Request, res: Response) => {
  try {
    const result = await AuthService.register(req.body);
    res.status(201).json({
      success: true,
      message: "Registration successful",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/login", validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip;
    const result = await AuthService.login(req.body.email, req.body.password, userAgent, ipAddress);
    res.json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error: any) {
    console.error("[Login Failure]", error.message);
    res.status(401).json({ success: false, message: error.message });
  }
});

router.post("/logout", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      await AuthService.logout(token);
    }
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await AuthService.getMe(req.userId!);
    res.json({ success: true, data: user });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

router.post("/forgot-password", validateBody(forgotPasswordSchema), async (req: Request, res: Response) => {
  try {
    const result = await AuthService.forgotPassword(req.body.email);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(6),
});

router.post("/reset-password", validateBody(resetPasswordSchema), async (req: Request, res: Response) => {
  try {
    const result = await AuthService.resetPassword(req.body.token, req.body.newPassword);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

router.post("/change-password", authenticate, validateBody(changePasswordSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await AuthService.changePassword(req.userId!, req.body.currentPassword, req.body.newPassword);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/verify-email", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await AuthService.verifyEmail(req.userId!);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /auth/verify-email/:token (Public link clicked from email)
router.get("/verify-email/:token", async (req: Request, res: Response) => {
  try {
    const { OtpService } = await import("../services/otpService.js");
    const result = await OtpService.verifyEmailToken(req.params.token);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /auth/resend-verification-email (Authenticated)
router.post("/resend-verification-email", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { OtpService } = await import("../services/otpService.js");
    await OtpService.sendEmailVerification(req.userId!);
    res.json({ success: true, message: "Verification email dispatched" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Phone OTP endpoints
const sendOtpSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits"),
});

router.post("/phone/send-otp", authenticate, validateBody(sendOtpSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { OtpService } = await import("../services/otpService.js");
    const result = await OtpService.sendPhoneOtp(req.userId!, req.body.phone);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const verifyOtpSchema = z.object({
  otp: z.string().length(6, "OTP must be 6 digits"),
});

router.post("/phone/verify-otp", authenticate, validateBody(verifyOtpSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { OtpService } = await import("../services/otpService.js");
    const result = await OtpService.verifyPhoneOtp(req.userId!, req.body.otp);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;

