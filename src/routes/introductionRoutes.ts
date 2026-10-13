import { Router, Response } from "express";
import { z } from "zod";
import { IntroductionService } from "../services/introductionService.js";
import { MatchingService } from "../services/matchingService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.get("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const intros = await IntroductionService.getIntroductionsForMember(req.userId!);
    res.json({ success: true, data: intros });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/find-matches", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const candidate = await MatchingService.findAndQueueMatches(req.userId!);
    res.json({
      success: true,
      message: candidate
        ? "Match queued for human matchmaking review"
        : "No additional matching profiles found at this time",
      data: candidate,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const respondSchema = z.object({
  decision: z.enum(["ACCEPTED", "DECLINED"]),
  declineReason: z.string().optional(),
});

router.post("/:id/respond", authenticate, validateBody(respondSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await IntroductionService.respondToIntroduction({
      introductionId: req.params.id,
      userId: req.userId!,
      decision: req.body.decision,
      declineReason: req.body.declineReason,
    });
    res.json({
      success: true,
      message: `Introduction marked as ${req.body.decision}`,
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const noteSchema = z.object({
  content: z.string().min(1, "Note cannot be empty").max(1000),
});

router.post("/:id/note", authenticate, validateBody(noteSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await IntroductionService.sendNote({
      introductionId: req.params.id,
      userId: req.userId!,
      content: req.body.content,
    });
    res.json({
      success: true,
      message: "Note sent successfully",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

const feedbackSchema = z.object({
  candidateId: z.string(),
  relevanceRating: z.number().min(1).max(5),
  expectationsMet: z.enum(["YES", "PARTIALLY", "NO"]),
  communicationFeedback: z.string().optional(),
  feedbackNotes: z.string().optional(),
});

router.post("/:id/feedback", authenticate, validateBody(feedbackSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await IntroductionService.submitFeedback({
      introductionId: req.params.id,
      userId: req.userId!,
      ...req.body,
    });
    res.json({
      success: true,
      message: "Thank you for your feedback! It helps refine future hand-picked matches.",
      data: result,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
