import { Schema, model } from 'mongoose';
import { BILLING_INTERVALS } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const priceMap = Object.fromEntries(BILLING_INTERVALS.map((i) => [i, { type: Number, min: 0 }]));

/** Editable from the admin (Phase 10). Money is integer paise, GST inclusive. */
const planSchema = new Schema(
  {
    schemaVersion,
    code: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['subscription', 'pack'], required: true },
    name: { type: String, required: true },
    tagline: String,
    prices: { type: new Schema(priceMap, { _id: false }), default: {} },
    credits: { type: Number, default: 0, min: 0 },
    fairUseCap: Number,
    features: [String],
    highlight: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
    razorpayPlanIds: { type: Schema.Types.Mixed, default: {} },
  },
  base,
);

/** Only published stories with explicit consent are ever returned publicly. */
const successStorySchema = new Schema(
  {
    schemaVersion,
    coupleNames: { type: String, required: true },
    city: String,
    quote: { type: String, required: true, maxlength: 600 },
    photoKey: String,
    marriedOn: Date,
    consentGivenAt: Date,
    consentRecordedBy: Schema.Types.ObjectId,
    published: { type: Boolean, default: false, index: true },
    sortOrder: { type: Number, default: 0 },
    /** Member submissions: nothing is public until staff confirm the partner's consent. */
    status: { type: String, enum: ['draft', 'submitted', 'published', 'rejected', 'withdrawn'], default: 'draft', index: true },
    submittedBy: { type: Schema.Types.ObjectId, index: true },
    submittedAt: Date,
    originalQuote: String,
    decisionNote: String,
    partnerConsentConfirmedAt: Date,
  },
  base,
);

const guideSchema = new Schema(
  {
    schemaVersion,
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    summary: String,
    category: String,
    coverKey: String,
    bodyMarkdown: String,
    audioKey: String,
    audioSeconds: Number,
    access: { type: String, enum: ['free', 'premium'], default: 'free' },
    published: { type: Boolean, default: false, index: true },
    publishedAt: Date,
  },
  base,
);

/** Where a member got to in a guide, so audio and reading resume on any device. */
const guideProgressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    slug: { type: String, required: true },
    positionSec: { type: Number, default: 0, min: 0 },
    scrollPct: { type: Number, default: 0, min: 0, max: 100 },
    speed: { type: Number, default: 1, min: 0.5, max: 2 },
    completed: { type: Boolean, default: false },
  },
  base,
);
guideProgressSchema.index({ userId: 1, slug: 1 }, { unique: true });

const contactMessageSchema = new Schema(
  {
    schemaVersion,
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, maxlength: 254 },
    topic: { type: String, enum: ['general', 'support', 'press', 'partnership', 'grievance'], default: 'general' },
    message: { type: String, required: true, maxlength: 4000 },
    ip: String,
    status: { type: String, enum: ['new', 'handled'], default: 'new', index: true },
  },
  base,
);

export const Plan = model('Plan', planSchema);
export const SuccessStory = model('SuccessStory', successStorySchema);
export const Guide = model('Guide', guideSchema);
export const GuideProgress = model('GuideProgress', guideProgressSchema);
export const ContactMessage = model('ContactMessage', contactMessageSchema);
