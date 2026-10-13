import { Router, Response } from "express";
import { AssessmentService } from "../services/assessmentService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/questions", (req, res) => {
  res.json({
    success: true,
    data: AssessmentService.getQuestions(),
  });
});

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const assessment = await AssessmentService.getAssessmentByUserId(req.userId!);
    res.json({ success: true, data: assessment });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/submit", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const assessment = await AssessmentService.submitAssessment(req.userId!, req.body.answers);
    res.json({
      success: true,
      message: "Compatibility assessment recorded",
      data: assessment,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
