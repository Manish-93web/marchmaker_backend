import { Schema, model } from 'mongoose';
import { REFERRAL_STATUSES, WALLET_ENTRY_TYPES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Immutable record of every wallet movement; the balance on the user is a cache of it. */
const walletLedgerSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: WALLET_ENTRY_TYPES, required: true },
    deltaPaise: { type: Number, required: true },
    balanceAfterPaise: { type: Number, required: true },
    reason: String,
    orderId: Schema.Types.ObjectId,
    referralId: Schema.Types.ObjectId,
    actorId: Schema.Types.ObjectId,
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  base,
);
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  walletLedgerSchema.pre(op, () => {
    throw new Error('The wallet ledger is immutable');
  });
}

const referralSchema = new Schema(
  {
    schemaVersion,
    referrerId: { type: Schema.Types.ObjectId, required: true, index: true },
    refereeId: { type: Schema.Types.ObjectId, required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: REFERRAL_STATUSES, default: 'attributed', index: true },
    flags: [String],
    qualifyingPaymentId: Schema.Types.ObjectId,
    qualifiedAt: Date,
    releaseAt: { type: Date, index: true },
    referrerRewardPaise: Number,
    refereeRewardPaise: Number,
    rewardedAt: Date,
    decisionNote: String,
    decidedBy: Schema.Types.ObjectId,
    rejectedReason: String,
  },
  base,
);

export const WalletLedger = model('WalletLedger', walletLedgerSchema);
export const Referral = model('Referral', referralSchema);
