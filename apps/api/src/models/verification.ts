import { Schema, model } from 'mongoose';
import { ID_DOC_TYPES, VERIFICATION_STATUSES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const evidence = new Schema(
  {
    key: String,
    contentType: String,
    sizeBytes: Number,
    uploadedAt: Date,
    purgedAt: Date,
  },
  { _id: false },
);

/** One verification attempt: manual (uploaded evidence) or automated (KYC session). */
const verificationSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['id'], default: 'id' },
    method: { type: String, enum: ['manual', 'kyc'], required: true },
    status: { type: String, enum: VERIFICATION_STATUSES, default: 'draft', index: true },
    docType: { type: String, enum: ID_DOC_TYPES },
    /** Last four characters only. The full document number is never collected or stored. */
    docLast4: String,
    evidence: {
      id_front: evidence,
      id_back: evidence,
      selfie: evidence,
    },
    reuploadKinds: [String],
    submittedAt: Date,

    checklist: Schema.Types.Mixed,
    reviewerId: Schema.Types.ObjectId,
    decisionReason: String,
    decisionNote: String,
    decidedAt: Date,
    decidedBy: { type: String, enum: ['staff', 'provider'] },
    manualReason: String,

    provider: {
      name: String,
      sessionId: { type: String, index: true, sparse: true },
      redirectUrl: String,
      confidence: Number,
      faceMatch: Boolean,
      livenessPassed: Boolean,
      nameMatch: Boolean,
      dobMatch: Boolean,
      attempts: { type: Number, default: 0 },
      lastPolledAt: Date,
      lastError: String,
    },

    /** Raw images are deleted after this date; the decision record stays. */
    purgeAfter: { type: Date, index: true },
    evidencePurgedAt: Date,
  },
  base,
);
verificationSchema.index({ status: 1, submittedAt: 1 });

/** Provider callbacks, persisted before processing so redelivery is idempotent. */
const webhookEventSchema = new Schema(
  {
    schemaVersion,
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    payload: Schema.Types.Mixed,
    signatureValid: { type: Boolean, default: false },
    processedAt: Date,
    attempts: { type: Number, default: 0 },
    error: String,
  },
  base,
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const Verification = model('Verification', verificationSchema);
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
