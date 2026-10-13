import { Types } from "mongoose";
import { WalletAccount, WalletLedgerEntry, IWalletAccount, IWalletLedgerEntry } from "../models/Wallet.js";
import { Notification } from "../models/Notification.js";

export class WalletService {
  static async getWallet(userId: string): Promise<IWalletAccount | null> {
    return WalletAccount.findOne({ userId });
  }

  static async getLedgerHistory(userId: string, limit = 50): Promise<IWalletLedgerEntry[]> {
    return WalletLedgerEntry.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  static async creditReferralBonus(data: {
    referrerCode: string;
    invitedUserId: string;
    amountINR: number;
    idempotencyKey: string;
  }): Promise<boolean> {
    const wallet = await WalletAccount.findOne({ referralCode: data.referrerCode.toUpperCase() });
    if (!wallet) return false;

    // Idempotency check: prevent duplicate reward credit
    const existingEntry = await WalletLedgerEntry.findOne({ idempotencyKey: data.idempotencyKey });
    if (existingEntry) {
      return true; // Already processed
    }

    wallet.balanceINR += data.amountINR;
    wallet.totalEarnedINR += data.amountINR;
    await wallet.save();

    await WalletLedgerEntry.create({
      walletId: wallet._id,
      userId: wallet.userId,
      type: "CREDIT",
      amountINR: data.amountINR,
      balanceAfterINR: wallet.balanceINR,
      reason: "Referral Reward: Friend verified profile",
      idempotencyKey: data.idempotencyKey,
      referenceType: "REFERRAL_BONUS",
      referenceId: data.invitedUserId,
    });

    await Notification.create({
      userId: wallet.userId,
      title: "Wallet Credited! 🎁",
      message: `You earned ₹${data.amountINR} referral bonus! Your new wallet balance is ₹${wallet.balanceINR}.`,
      category: "PAYMENT",
      deepLink: "/dashboard/wallet",
    });

    return true;
  }
}
