import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  ACCOUNT_STATUSES,
  GENDERS,
  JOURNEY_STATES,
  ROLES,
  PLAN_CODES,
} from '@marchmaker/shared';

const baseOptions = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const userSchema = new Schema(
  {
    schemaVersion,
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    emailVerifiedAt: Date,
    /** AES-256-GCM ciphertext; use phoneHash for lookups. */
    phoneEnc: String,
    phoneHash: { type: String, index: true, sparse: true },
    phoneVerifiedAt: Date,
    passwordHash: { type: String, select: false },
    firstName: { type: String, required: true, trim: true },
    gender: { type: String, enum: GENDERS, required: true },
    dobEnc: { type: String, required: true },
    dobYear: { type: Number, index: true },
    roles: { type: [String], enum: ROLES, default: ['member'] },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'active', index: true },
    journeyState: { type: String, enum: JOURNEY_STATES, default: 'registered', index: true },
    lastActiveAt: Date,
    verification: {
      idVerifiedAt: Date,
      selfieVerifiedAt: Date,
      livenessVerifiedAt: Date,
    },
    plan: {
      planCode: { type: String, enum: PLAN_CODES, default: 'free' },
      status: { type: String, default: 'none' },
      currentPeriodEnd: Date,
    },
    /** Available credits. Held credits (accepted, waiting on the other person) are tracked separately. */
    creditBalance: { type: Number, default: 0, min: 0 },
    creditsReserved: { type: Number, default: 0, min: 0 },
    billing: { legalName: String, gstin: String, stateCode: String },
    walletBalancePaise: { type: Number, default: 0, min: 0 },
    referralCode: { type: String, unique: true, sparse: true },
    /** Keyed hash of the sign-up network address, only used to spot self-referrals. */
    signupIpHash: String,
    /** Keyed hash of the browser's random device id at sign-up, used only to spot self-referrals. */
    signupDeviceHash: String,
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notificationPrefs: { type: Schema.Types.Mixed, default: {} },
    locale: { type: String, default: 'en-IN' },
    twoFactor: {
      secretEnc: { type: String, select: false },
      enabled: { type: Boolean, default: false },
      /** Keyed hashes of unused one-time recovery codes. */
      recoveryHashes: { type: [String], select: false },
      /** Recently accepted authenticator codes (keyed hashes), so a code works only once. */
      recentCodes: { type: [{ _id: false, h: String, at: Date }], select: false },
    },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
    pausedAt: Date,
    statusBeforeDeletion: String,
    journeyBeforeDeletion: String,
    /** Set by moderators: matches involving this member need two different approvers. */
    reviewFlags: { twoPerson: { type: Boolean, default: false } },
    /** Where the member was before a staff suspension or ban, so lifting it restores their place. */
    moderation: {
      journeyBefore: String,
      statusBefore: String,
      reason: String,
      by: Schema.Types.ObjectId,
      at: Date,
    },
    deletedAt: Date,
    deletionScheduledFor: Date,
  },
  baseOptions,
);
userSchema.index({ status: 1, journeyState: 1, lastActiveAt: -1 });

const sessionSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    userAgent: String,
    ip: String,
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: Date,
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: Date,
    revokedReason: String,
    mfa: { type: Boolean, default: false },
  },
  baseOptions,
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Append-only. Updates and deletes are blocked at the model layer; also restrict at DB-user level. */
const auditLogSchema = new Schema(
  {
    schemaVersion,
    actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorRoles: [String],
    action: { type: String, required: true, index: true },
    subjectType: String,
    subjectId: { type: String, index: true },
    ip: String,
    userAgent: String,
    requestId: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now, index: true, immutable: true },
  },
  { versionKey: false },
);
const blocked = () => {
  throw new Error('auditLogs is append-only');
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'replaceOne',
] as const) {
  auditLogSchema.pre(op, blocked);
}

const outboxSchema = new Schema(
  {
    schemaVersion,
    eventType: { type: String, required: true, index: true },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'dispatched', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: Date.now, index: true },
    lastError: String,
  },
  baseOptions,
);
outboxSchema.index({ status: 1, nextRunAt: 1 });

const settingSchema = new Schema(
  { key: { type: String, unique: true, required: true }, value: Schema.Types.Mixed, updatedBy: Schema.Types.ObjectId },
  baseOptions,
);

const featureFlagSchema = new Schema(
  {
    key: { type: String, unique: true, required: true },
    enabled: { type: Boolean, default: false },
    description: String,
    updatedBy: Schema.Types.ObjectId,
  },
  baseOptions,
);

const stateTransitionSchema = new Schema(
  {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    from: String,
    to: { type: String, required: true },
    actorId: Schema.Types.ObjectId,
    reason: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
stateTransitionSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const User = model('User', userSchema);
export const Session = model('Session', sessionSchema);
export const AuditLog = model('AuditLog', auditLogSchema);
export const Outbox = model('Outbox', outboxSchema);
export const Setting = model('Setting', settingSchema);
export const FeatureFlag = model('FeatureFlag', featureFlagSchema);
export const StateTransition = model('StateTransition', stateTransitionSchema);

export type UserDoc = InferSchemaType<typeof userSchema>;
