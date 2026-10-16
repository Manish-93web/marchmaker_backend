import { Schema, model } from 'mongoose';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const callLogSchema = new Schema(
  {
    schemaVersion,
    introductionId: { type: Schema.Types.ObjectId, required: true, index: true },
    initiatedBy: { type: Schema.Types.ObjectId, required: true },
    providerCallId: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['initiated', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy'], default: 'initiated' },
    durationSec: Number,
    /** phone = bridged through the telephony provider; webrtc = in-app voice. */
    mode: { type: String, enum: ['phone', 'webrtc'], default: 'phone' },
    startedAt: Date,
    endedAt: Date,
  },
  base,
);
callLogSchema.index({ introductionId: 1, createdAt: -1 });

/** Short-lived signalling messages between the two people on an in-app call. They expire after five minutes. */
const callSignalSchema = new Schema(
  {
    callId: { type: Schema.Types.ObjectId, required: true, index: true },
    introductionId: { type: Schema.Types.ObjectId, required: true },
    from: { type: Schema.Types.ObjectId, required: true },
    to: { type: Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, required: true },
    payload: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now, expires: 300 },
  },
  { versionKey: false },
);

/** Birth details are encrypted at rest and removed on request or with the account. */
const astroProfileSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    birthEnc: { type: String, required: true },
    /** The member agrees that a compatibility reading with an unlocked match may use these details. */
    shareWithMatches: { type: Boolean, default: false },
  },
  base,
);

const astroReportSchema = new Schema(
  {
    schemaVersion,
    kind: { type: String, enum: ['kundli', 'match'], required: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    introductionId: Schema.Types.ObjectId,
    memberIds: [{ type: Schema.Types.ObjectId, index: true }],
    provider: String,
    sample: Boolean,
    payload: Schema.Types.Mixed,
  },
  base,
);
astroReportSchema.index({ introductionId: 1, kind: 1 }, { unique: true, partialFilterExpression: { introductionId: { $exists: true } } });

export const CallLog = model('CallLog', callLogSchema);
export const CallSignal = model('CallSignal', callSignalSchema);
export const AstroProfile = model('AstroProfile', astroProfileSchema);
export const AstroReport = model('AstroReport', astroReportSchema);
