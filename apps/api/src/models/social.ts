import { Schema, model } from 'mongoose';
import { CREDIT_LEDGER_TYPES, REPORT_CATEGORIES, SEVERITIES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Immutable. Balances are derived from this and cached on the user in the same transaction. */
const creditLedgerSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: CREDIT_LEDGER_TYPES, required: true },
    /** Change to the member's available balance. */
    delta: { type: Number, required: true },
    /** Change to the held (reserved) amount. */
    heldDelta: { type: Number, default: 0 },
    balanceAfter: { type: Number, required: true },
    heldAfter: { type: Number, required: true },
    reason: String,
    introductionId: { type: Schema.Types.ObjectId, index: true, sparse: true },
    actorId: Schema.Types.ObjectId,
    /** Prevents the same business event from being recorded twice. */
    idempotencyKey: { type: String, unique: true, sparse: true },
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false },
);
const frozen = () => {
  throw new Error('creditLedger is immutable');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  creditLedgerSchema.pre(op, frozen);
}

const threadSchema = new Schema(
  {
    schemaVersion,
    introductionId: { type: Schema.Types.ObjectId, ref: 'Introduction', required: true, unique: true },
    members: { type: [Schema.Types.ObjectId], required: true, index: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    closedReason: String,
    lastMessageAt: Date,
    lastMessagePreview: String,
    /** Per-member read marker, so unread counts need no per-message updates. */
    lastRead: { type: Schema.Types.Mixed, default: {} },
  },
  base,
);

const messageSchema = new Schema(
  {
    schemaVersion,
    threadId: { type: Schema.Types.ObjectId, ref: 'MessageThread', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 1200 },
    clientId: String,
    readAt: Date,
  },
  base,
);
messageSchema.index({ threadId: 1, createdAt: 1 });
messageSchema.index({ threadId: 1, clientId: 1 }, { unique: true, sparse: true });

const reportSchema = new Schema(
  {
    schemaVersion,
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reportedId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    introductionId: Schema.Types.ObjectId,
    category: { type: String, enum: REPORT_CATEGORIES, required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    details: String,
    status: { type: String, enum: ['open', 'investigating', 'action_taken', 'dismissed'], default: 'open', index: true },
    /** A frozen copy of the recent conversation, so evidence survives later deletion. */
    transcript: [{ _id: false, at: Date, senderId: String, body: String }],
    /** Moderation workflow */
    assigneeId: Schema.Types.ObjectId,
    claimedAt: Date,
    slaDueAt: { type: Date, index: true },
    escalated: { type: Boolean, default: false },
    slaAlertedAt: Date,
    /** Set when staff raise the report from a support ticket. */
    sourceTicketId: Schema.Types.ObjectId,
    /** Reporter screenshots, private in the documents bucket. */
    evidence: [{ _id: false, key: String, name: String, contentType: String, size: Number }],
    resolution: { action: String, reason: String, by: Schema.Types.ObjectId, at: Date },
  },
  base,
);
reportSchema.index({ severity: 1, status: 1, createdAt: 1 });

/** Replays the stored result when a client retries the same logical request. */
const idempotencySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['processing', 'done'], default: 'processing' },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true },
);
idempotencySchema.index({ userId: 1, route: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CreditLedger = model('CreditLedger', creditLedgerSchema);
export const MessageThread = model('MessageThread', threadSchema);
export const Message = model('Message', messageSchema);
export const Report = model('Report', reportSchema);
export const IdempotencyKey = model('IdempotencyKey', idempotencySchema);
