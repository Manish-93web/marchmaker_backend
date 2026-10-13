import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import app from "../app.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { User } from "../models/User.js";
import { Introduction } from "../models/Introduction.js";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await connectDatabase(uri);
});

afterAll(async () => {
  await disconnectDatabase();
  await mongoServer.stop();
});

describe("Marchmaker Platform Integration Test Suite", () => {
  let memberToken = "";
  let memberId = "";
  let adminToken = "";
  let adminId = "";
  let candidateToken = "";
  let candidateId = "";

  // 1. Health check
  it("GET /health returns 200 OK", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("marchmaker_backend");
  });

  // 2. Member Registration
  it("POST /api/v1/auth/register registers a new member", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      email: "aarav.sharma@example.com",
      password: "SecurePassword123!",
      fullName: "Aarav Sharma",
      phone: "+919876543210",
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe("aarav.sharma@example.com");
    expect(res.body.data.token).toBeDefined();

    memberToken = res.body.data.token;
    memberId = res.body.data.user._id;
  });

  // 3. Duplicate email rejection
  it("POST /api/v1/auth/register rejects duplicate email", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      email: "aarav.sharma@example.com",
      password: "PasswordAgain",
      fullName: "Aarav Duplicate",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // 4. Member Login
  it("POST /api/v1/auth/login authenticates registered member", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({
      email: "aarav.sharma@example.com",
      password: "SecurePassword123!",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
  });

  // 5. Auth /me
  it("GET /api/v1/auth/me returns current user profile", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe("Aarav Sharma");
  });

  // 6. Guided Profile Draft Autosave
  it("PATCH /api/v1/profile/draft autosaves onboarding steps and calculates completeness", async () => {
    const res = await request(app)
      .patch("/api/v1/profile/draft")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        step: 2,
        data: {
          gender: "MALE",
          dateOfBirth: "1994-06-15",
          heightCm: 178,
          maritalStatus: "NEVER_MARRIED",
          religion: "Hindu",
          motherTongue: "Hindi",
          city: "New Delhi",
          state: "Delhi",
          educationLevel: "Masters",
          highestDegree: "M.Tech Computer Science",
          employedIn: "Private Sector",
          occupationTitle: "Senior Software Architect",
          annualIncomeINR: 3200000,
          bio: "Passionate engineer who loves traveling, photography, and building meaningful connections.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.completionPercentage).toBeGreaterThanOrEqual(70);
  });

  // 7. Full Profile Submission
  it("POST /api/v1/profile/submit marks profile as submitted", async () => {
    const res = await request(app)
      .post("/api/v1/profile/submit")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isProfileSubmitted).toBe(true);
  });

  // 8. Partner Preferences
  it("PUT /api/v1/preferences/me updates partner expectations", async () => {
    const res = await request(app)
      .put("/api/v1/preferences/me")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        ageMin: 24,
        ageMax: 30,
        religions: ["Hindu"],
        maritalStatuses: ["NEVER_MARRIED"],
        locations: ["Delhi", "Gurugram", "Noida"],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.ageMin).toBe(24);
  });

  // 9. Compatibility Assessment
  it("POST /api/v1/assessment/submit computes dimension scores", async () => {
    const res = await request(app)
      .post("/api/v1/assessment/submit")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        answers: [
          {
            questionId: "VAL_01",
            dimension: "VALUES",
            questionText: "Rituals vs modern choices",
            selectedOption: "Respect traditions while welcoming modern flexibility",
            numericScore: 4,
          },
          {
            questionId: "COMM_01",
            dimension: "COMMUNICATION",
            questionText: "Disagreements",
            selectedOption: "Calmly discuss the matter immediately",
            numericScore: 5,
          },
          {
            questionId: "FIN_01",
            dimension: "FINANCES",
            questionText: "Finances",
            selectedOption: "Combined household fund plus independent accounts",
            numericScore: 4,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.isComplete).toBe(true);
    expect(res.body.data.dimensionScores.communication).toBeGreaterThan(0);
  });

  // 10. KYC Document Submission
  it("POST /api/v1/verification/submit accepts KYC documents and masks numbers", async () => {
    const res = await request(app)
      .post("/api/v1/verification/submit")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        documentType: "AADHAAR",
        documentNumber: "123456789012",
        documentUrl: "https://storage.marchmaker.in/private/docs/aadhaar_aarav.pdf",
        selfieUrl: "https://storage.marchmaker.in/private/selfies/selfie_aarav.jpg",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.maskedDocumentNumber).toBe("XXXXXXXX9012");
    expect(res.body.data.status).toBe("PENDING");
  });

  // 11. RBAC Guard: Member cannot access /api/v1/admin
  it("GET /api/v1/admin/stats returns 403 Forbidden for MEMBER role", async () => {
    const res = await request(app)
      .get("/api/v1/admin/stats")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
  });

  // 12. Create Super Admin user and test admin stats
  it("GET /api/v1/admin/stats returns 200 for SUPER_ADMIN", async () => {
    const adminUser = await User.create({
      email: "director@marchmaker.in",
      passwordHash: "dummyHash",
      fullName: "Platform Director",
      role: "SUPER_ADMIN",
      isEmailVerified: true,
    });

    adminId = adminUser._id.toString();

    const loginRes = await request(app).post("/api/v1/auth/register").send({
      email: "admin.match@marchmaker.in",
      password: "AdminPassword123!",
      fullName: "Chief Reviewer",
    });

    // Elevate role directly in DB
    await User.findByIdAndUpdate(loginRes.body.data.user._id, { role: "SUPER_ADMIN" });

    // Login to get token with admin role
    const adminLoginRes = await request(app).post("/api/v1/auth/login").send({
      email: "admin.match@marchmaker.in",
      password: "AdminPassword123!",
    });

    adminToken = adminLoginRes.body.data.token;

    const statsRes = await request(app)
      .get("/api/v1/admin/stats")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(statsRes.status).toBe(200);
    expect(statsRes.body.data.totalMembers).toBeGreaterThanOrEqual(1);
  });

  // 13. Admin reviews KYC
  it("POST /api/v1/admin/verifications/:id/decision approves member KYC", async () => {
    const verifRes = await request(app)
      .get("/api/v1/admin/verifications")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(verifRes.status).toBe(200);
    const requestId = verifRes.body.data.requests[0]._id;

    const decisionRes = await request(app)
      .post(`/api/v1/admin/verifications/${requestId}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        decision: "APPROVE",
      });

    expect(decisionRes.status).toBe(200);
    expect(decisionRes.body.data.status).toBe("APPROVED");
  });

  // 14. Register Candidate Profile and create Introduction
  it("Creates a candidate and generates a human-reviewed introduction", async () => {
    const candRes = await request(app).post("/api/v1/auth/register").send({
      email: "priya.verma@example.com",
      password: "PriyaSecurePassword123!",
      fullName: "Priya Verma",
    });
    candidateToken = candRes.body.data.token;
    candidateId = candRes.body.data.user._id;

    // Save profile for Priya
    await request(app)
      .patch("/api/v1/profile/draft")
      .set("Authorization", `Bearer ${candidateToken}`)
      .send({
        step: 3,
        data: {
          gender: "FEMALE",
          dateOfBirth: "1996-08-20",
          heightCm: 165,
          maritalStatus: "NEVER_MARRIED",
          religion: "Hindu",
          motherTongue: "Hindi",
          city: "New Delhi",
          state: "Delhi",
          educationLevel: "Masters",
          occupationTitle: "Product Designer",
          annualIncomeINR: 2400000,
          bio: "Curious designer who values family bonds, arts, and balanced living.",
        },
      });

    await request(app)
      .post("/api/v1/profile/submit")
      .set("Authorization", `Bearer ${candidateToken}`);

    // Create an introduction in PENDING_REVIEW state
    const intro = await Introduction.create({
      member1Id: new mongoose.Types.ObjectId(memberId),
      member2Id: new mongoose.Types.ObjectId(candidateId),
      status: "PENDING_REVIEW",
      compatibilityScore: 92,
      explainableHighlights: [
        "Aligned career values and balanced approach to modern marriage",
        "Compatible communication styles and respect for family traditions",
      ],
      reviewerNotes: "Excellent mutual alignment in education, city, and family expectations.",
    });

    // Reviewer approves the introduction
    const approveRes = await request(app)
      .post(`/api/v1/admin/reviews/${intro._id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        decision: "APPROVE",
        notes: "Approved after verifying partner preferences.",
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe("OFFERED");

    // Member views introductions
    const memberIntrosRes = await request(app)
      .get("/api/v1/introductions")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(memberIntrosRes.status).toBe(200);
    expect(memberIntrosRes.body.data.length).toBeGreaterThanOrEqual(1);

    // Payment order creation and unlock
    const orderRes = await request(app)
      .post("/api/v1/payments/create-order")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        introductionId: intro._id.toString(),
      });

    expect(orderRes.status).toBe(200);
    expect(orderRes.body.data.orderId).toBeDefined();

    const verifyRes = await request(app)
      .post("/api/v1/payments/verify")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        introductionId: intro._id.toString(),
        razorpayOrderId: orderRes.body.data.orderId,
        razorpayPaymentId: "pay_testMock12345",
        razorpaySignature: "mock_signature_dev",
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.invoiceNumber).toBeDefined();
  });

  // 15. DPDP Act Data Export
  it("GET /api/v1/privacy/export returns GDPR/DPDP compliant user export archive", async () => {
    const res = await request(app)
      .get("/api/v1/privacy/export")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.complianceStandard).toContain("DPDP Act");
    expect(res.body.data.user.email).toBe("aarav.sharma@example.com");
  });

  // 16. Journey Status Tracker
  it("GET /api/v1/member/journey-status reflects accurate stage progression", async () => {
    const res = await request(app)
      .get("/api/v1/member/journey-status")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.stages.length).toBe(7);
  });

  // 17. Phone OTP Flow
  it("POST /api/v1/auth/phone/send-otp & verify-otp verifies phone number", async () => {
    const sendRes = await request(app)
      .post("/api/v1/auth/phone/send-otp")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ phone: "9876543210" });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.success).toBe(true);
    const testOtp = sendRes.body.testOtp;
    expect(testOtp).toBeDefined();

    const verifyRes = await request(app)
      .post("/api/v1/auth/phone/verify-otp")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ otp: testOtp });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);

    const meRes = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(meRes.body.data.isPhoneVerified).toBe(true);
  });

  // 18. Automated KYC Validation (Verhoeff Checksum)
  it("POST /api/v1/verification/validate-document validates Indian identity formats", async () => {
    // Invalid Aadhaar (wrong length)
    const invalidRes = await request(app)
      .post("/api/v1/verification/validate-document")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ documentType: "AADHAAR", documentNumber: "12345" });
    expect(invalidRes.status).toBe(400);

    // Valid Passport format
    const passportRes = await request(app)
      .post("/api/v1/verification/validate-document")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ documentType: "PASSPORT", documentNumber: "A1234567" });
    expect(passportRes.status).toBe(200);
    expect(passportRes.body.data.masked).toBe("A1XXXX67");
  });

  // 19. Interactive Liveness Challenge
  it("POST /api/v1/verification/liveness/start and verify verifies interactive camera session", async () => {
    const startRes = await request(app)
      .post("/api/v1/verification/liveness/start")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(startRes.status).toBe(200);
    expect(startRes.body.data.sessionId).toBeDefined();
    expect(startRes.body.data.actions.length).toBeGreaterThan(0);

    const verifyRes = await request(app)
      .post("/api/v1/verification/liveness/verify")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        sessionId: startRes.body.data.sessionId,
        completedActions: startRes.body.data.actions,
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.isPassed).toBe(true);
  });

  // 20. Meta WhatsApp Webhook Challenge
  it("GET /api/v1/whatsapp/webhook validates Meta verification challenge", async () => {
    const res = await request(app).get("/api/v1/whatsapp/webhook").query({
      "hub.mode": "subscribe",
      "hub.verify_token": "marchmaker_wa_verify_2026",
      "hub.challenge": "challenge_token_999",
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe("challenge_token_999");
  });

  // 21. Relationship E-Guides Catalog & Progress
  it("GET /api/v1/guides lists curriculum and saves playback progress", async () => {
    const listRes = await request(app)
      .get("/api/v1/guides")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);

    const firstGuide = listRes.body.data[0];

    const progressRes = await request(app)
      .post("/api/v1/guides/progress")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        guideId: firstGuide._id,
        playbackPositionSeconds: 120,
        isCompleted: true,
      });

    expect(progressRes.status).toBe(200);
    expect(progressRes.body.data.playbackPositionSeconds).toBe(120);
    expect(progressRes.body.data.isCompleted).toBe(true);
  });

  // 22. Presigned Direct Media Upload URL
  it("POST /api/v1/profile/photos/presigned-upload generates signed storage URL", async () => {
    const res = await request(app)
      .post("/api/v1/profile/photos/presigned-upload")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        fileName: "profile_pic.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.uploadUrl).toContain("storage.marchmaker.in");
    expect(res.body.data.expiresInSeconds).toBe(900);
  });

  // 23. Background Automation & Cron Workers
  it("CronService runs background jobs without crashing", async () => {
    const { CronService } = await import("../services/cronService.js");
    const results = await CronService.runAllJobs();
    expect(results).toBeDefined();
    expect(results.expiredIntroductions).toBeGreaterThanOrEqual(0);
    expect(results.dpdpPurges).toBeGreaterThanOrEqual(0);
  });
});

