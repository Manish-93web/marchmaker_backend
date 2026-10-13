import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "5000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/marchmaker_db",
  jwtSecret: process.env.JWT_SECRET || "marchmaker-super-secret-jwt-key-2026",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_sampleKey123",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "sampleSecretKey123",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "sampleWebhookSecret123",
    // Introduction Unlock Price in INR (Inclusive of 18% GST)
    introductionFeeINR: 499,
  },

  email: {
    smtpHost: process.env.SMTP_HOST || "smtp.mailtrap.io",
    smtpPort: parseInt(process.env.SMTP_PORT || "2525", 10),
    smtpUser: process.env.SMTP_USER || "test_user",
    smtpPass: process.env.SMTP_PASS || "test_pass",
    from: process.env.EMAIL_FROM || "Marchmaker Matchmaking <support@marchmaker.in>",
  },
};
