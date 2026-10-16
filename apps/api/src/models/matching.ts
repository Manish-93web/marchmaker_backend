import { Schema, model } from 'mongoose';
import { INTRO_STATES, SUGGESTION_STATUSES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const history = new Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: String, required: true }, // user id, or "system"
    action: { type: String, required: true },
    note: String,
    details: Schema.Types.Mixed,
  },
  { _id: false },
);

/** A proposed pair. Nothing reaches a member until a person approves it and the cool-off passes. */
const suggestionSchema = new Schema(
  {
    schemaVersion,
    /** Sorted "idA:idB". Unique, so a pair can only ever have one suggestion. */
    pairKey: { type: String, required: true, unique: true },
    memberA: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    memberB: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Internal only. Never returned to members. */
    score: { type: Number, required: true },
    signals: Schema.Types.Mixed,
    reasons: [{ _id: false, code: String, dimension: String }],
    assessmentsMissing: Boolean,
    status: { type: String, enum: SUGGESTION_STATUSES, default: 'suggested', index: true },
    reviewerId: Schema.Types.ObjectId,
    claimedAt: Date,
    whyText: String,
    approvals: [{ _id: false, userId: Schema.Types.ObjectId, at: Date }],
    needsTwoPerson: { type: Boolean, default: false },
    rejectionCode: String,
    snoozeUntil: Date,
    escalation: { by: Schema.Types.ObjectId, reason: String, at: Date },
    releaseAt: Date,
    releasedAt: Date,
    introductionId: Schema.Types.ObjectId,
    manual: { type: Boolean, default: false },
    overrides: [{ _id: false, by: String, dimension: String }],
    runId: String,
    generatedAt: Date,
    reviewHistory: [history],
  },
  base,
);
suggestionSchema.index({ status: 1, createdAt: 1 });
suggestionSchema.index({ status: 1, releaseAt: 1 });
suggestionSchema.index({ status: 1, snoozeUntil: 1 });

const memberState = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    viewedAt: Date,
    firstNote: String,
    respondedAt: Date,
    declineReason: String,
    declineNote: String,
    contactShared: { type: Boolean, default: false },
    /** Open to a masked voice call with this person. Both must opt in. */
    voiceOptIn: { type: Boolean, default: false },
  },
  { _id: false },
);

/** The introduction a member actually sees. Accept/decline lifecycle arrives in Phase 9. */
const introductionSchema = new Schema(
  {
    schemaVersion,
    pairKey: { type: String, required: true, unique: true },
    suggestionId: { type: Schema.Types.ObjectId, ref: 'MatchSuggestion' },
    members: { type: [memberState], validate: (v: unknown[]) => v.length === 2 },
    whyText: { type: String, required: true },
    /** Plain-language shared-ground sentences shown on the card. Never numeric. */
    highlights: { type: [String], default: [] },
    remindersSent: { type: [Number], default: [] },
    closedReason: String,
    state: { type: String, enum: INTRO_STATES, default: 'released', index: true },
    releasedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    unlockedAt: Date,
    creditTxIds: [String],
  },
  base,
);
introductionSchema.index({ 'members.userId': 1, state: 1 });

const blockSchema = new Schema(
  {
    schemaVersion,
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: String,
  },
  base,
);
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ blockedId: 1 });

export const MatchSuggestion = model('MatchSuggestion', suggestionSchema);
export const Introduction = model('Introduction', introductionSchema);
export const Block = model('Block', blockSchema);
