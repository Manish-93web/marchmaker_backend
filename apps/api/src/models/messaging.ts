import { Schema, model } from 'mongoose';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** One row per provider event. The id makes redelivery harmless. */
const emailEventSchema = new Schema(
  {
    providerEventId: { type: String, required: true, unique: true },
    providerMessageId: { type: String, index: true },
    type: { type: String, required: true },
    /** Keyed hash of the address: enough to correlate, nothing to leak. */
    toHash: { type: String, index: true },
    reason: String,
    at: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
emailEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const suppressionSchema = new Schema(
  {
    schemaVersion,
    toHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['hard_bounce', 'complaint', 'unsubscribed'], required: true },
    reason: String,
    source: { type: String, enum: ['provider', 'staff'], default: 'provider' },
    removedBy: Schema.Types.ObjectId,
  },
  base,
);

const whatsappTemplateSchema = new Schema(
  {
    schemaVersion,
    name: { type: String, required: true },
    language: { type: String, default: 'en' },
    category: { type: String, enum: ['utility', 'authentication', 'marketing'], default: 'utility' },
    /** Number of {{n}} variables the approved template expects. */
    variables: { type: Number, default: 0 },
    body: String,
    approvalStatus: { type: String, enum: ['draft', 'pending', 'approved', 'rejected'], default: 'draft' },
    purpose: String,
  },
  base,
);
whatsappTemplateSchema.index({ name: 1, language: 1 }, { unique: true });

/** Explicit opt-in and opt-out history, separate from the general consent log. */
const whatsappOptInSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    phoneHash: { type: String, required: true, index: true },
    status: { type: String, enum: ['opted_in', 'opted_out'], required: true },
    source: { type: String, enum: ['settings', 'keyword', 'staff'], required: true },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export const EmailEvent = model('EmailEvent', emailEventSchema);
export const EmailSuppression = model('EmailSuppression', suppressionSchema);
export const WhatsAppTemplate = model('WhatsAppTemplate', whatsappTemplateSchema);
export const WhatsAppOptIn = model('WhatsAppOptIn', whatsappOptInSchema);
