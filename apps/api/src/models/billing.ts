import { Schema, model } from 'mongoose';
import { BILLING_INTERVALS, SUBSCRIPTION_STATES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** A batch of credits with its own expiry, so subscription credits can roll over once and then lapse. */
const creditLotSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    source: { type: String, enum: ['subscription', 'pack', 'admin', 'referral'], required: true },
    amount: { type: Number, required: true, min: 1 },
    remaining: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, index: true, sparse: true },
    /** Business reference that created the lot, for idempotent grants. */
    ref: { type: String, unique: true, sparse: true },
    expiredAt: Date,
  },
  base,
);
creditLotSchema.index({ userId: 1, remaining: 1, expiresAt: 1 });

const orderSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packCode: { type: String, required: true },
    credits: { type: Number, required: true },
    listPricePaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    /** Paid from the wallet; amountPaise is what is left to pay in cash. */
    walletPaise: { type: Number, default: 0 },
    amountPaise: { type: Number, required: true },
    couponCode: String,
    couponId: Schema.Types.ObjectId,
    razorpayOrderId: { type: String, required: true, unique: true },
    receipt: String,
    status: { type: String, enum: ['created', 'paid', 'failed', 'expired'], default: 'created', index: true },
    paidAt: Date,
    invoiceId: Schema.Types.ObjectId,
    flags: [String],
  },
  base,
);

const refundEntry = new Schema(
  {
    razorpayRefundId: String,
    amountPaise: Number,
    reason: String,
    status: String,
    by: Schema.Types.ObjectId,
    at: { type: Date, default: Date.now },
    creditNoteId: Schema.Types.ObjectId,
    creditsRevoked: Number,
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    razorpayPaymentId: { type: String, required: true, unique: true },
    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpaySubscriptionId: { type: String, index: true, sparse: true },
    kind: { type: String, enum: ['pack', 'subscription'], required: true },
    planCode: String,
    interval: String,
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['captured', 'failed', 'refunded', 'partially_refunded'], required: true },
    method: String,
    errorCode: String,
    capturedAt: Date,
    refundedPaise: { type: Number, default: 0 },
    refunds: [refundEntry],
    invoiceId: Schema.Types.ObjectId,
    creditsGranted: { type: Number, default: 0 },
  },
  base,
);

const subscriptionSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    planCode: { type: String, required: true },
    interval: { type: String, enum: BILLING_INTERVALS, required: true },
    razorpaySubscriptionId: { type: String, required: true, unique: true },
    razorpayPlanId: String,
    status: { type: String, enum: SUBSCRIPTION_STATES, default: 'created', index: true },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    graceUntil: Date,
    pendingChange: { planCode: String, interval: String, at: Date },
    shortUrl: String,
    couponCode: String,
    lastSyncedAt: Date,
  },
  base,
);
subscriptionSchema.index({ userId: 1, status: 1 });

const invoiceSchema = new Schema(
  {
    schemaVersion,
    number: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['invoice', 'credit_note'], default: 'invoice' },
    financialYear: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, index: true },
    relatesTo: Schema.Types.ObjectId,
    lineItems: [{ _id: false, description: String, sac: String, taxablePaise: Number }],
    tax: {
      ratePercent: Number,
      taxablePaise: Number,
      cgstPaise: Number,
      sgstPaise: Number,
      igstPaise: Number,
      totalTaxPaise: Number,
      totalPaise: Number,
      intraState: Boolean,
    },
    buyer: { name: String, gstin: String, stateCode: String, email: String },
    seller: { name: String, gstin: String, stateCode: String, address: String },
    placeOfSupply: String,
    issuedAt: { type: Date, default: Date.now },
    pdfKey: String,
    emailedAt: Date,
  },
  base,
);

const counterSchema = new Schema({ key: { type: String, unique: true, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });

const couponSchema = new Schema(
  {
    schemaVersion,
    code: { type: String, required: true, unique: true },
    description: String,
    kind: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true },
    maxDiscountPaise: Number,
    expiresAt: Date,
    maxUses: Number,
    usedCount: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },
    appliesTo: { type: [String], default: [] },
    razorpayOfferId: String,
    active: { type: Boolean, default: true },
    createdBy: Schema.Types.ObjectId,
  },
  base,
);

const redemptionSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, unique: true, sparse: true },
    subscriptionId: String,
    status: { type: String, enum: ['reserved', 'confirmed', 'released'], default: 'reserved' },
    discountPaise: Number,
  },
  base,
);

export const CreditLot = model('CreditLot', creditLotSchema);
export const Order = model('Order', orderSchema);
export const Payment = model('Payment', paymentSchema);
export const Subscription = model('Subscription', subscriptionSchema);
export const Invoice = model('Invoice', invoiceSchema);
export const InvoiceCounter = model('InvoiceCounter', counterSchema);
export const Coupon = model('Coupon', couponSchema);
export const CouponRedemption = model('CouponRedemption', redemptionSchema);
