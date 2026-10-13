import { Router, Response } from "express";
import { WalletService } from "../services/walletService.js";
import { authenticate, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/me", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const wallet = await WalletService.getWallet(req.userId!);
    res.json({ success: true, data: wallet });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/ledger", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ledger = await WalletService.getLedgerHistory(req.userId!);
    res.json({ success: true, data: ledger });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
