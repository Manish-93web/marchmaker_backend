import { Schema, model } from 'mongoose';
import { CONSENT_PURPOSES, LEGAL_TYPES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Numeric one-time codes (SMS / email OTP). Only the keyed hash is stored. */
const otpSchema = new Schema(
  {
    schemaVersion,
    target: { type: String, required: true, index: true },
    purpose: { type: String, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  base,
);
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ target: 1, purpose: 1, createdAt: -1 });

/** Single-use link tokens: email verification, password reset, contact change. */
const tokenSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['verify_email', 'password_reset', 'change_email'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    payload: Schema.Types.Mixed,
    usedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  base,
);
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const legalDocumentSchema = new Schema(
  {
    schemaVersion,
    type: { type: String, enum: LEGAL_TYPES, required: true },
    version: { type: String, required: true },
    title: { type: String, required: true },
    effectiveDate: { type: Date, required: true },
    markdown: { type: String, required: true },
    /** Material changes force members to re-accept. */
    material: { type: Boolean, default: true },
    publishedBy: Schema.Types.ObjectId,
  },
  base,
);
legalDocumentSchema.index({ type: 1, version: 1 }, { unique: true });
legalDocumentSchema.index({ type: 1, effectiveDate: -1 });

/** Granular, purpose-specific consent (DPDP Act 2023). Append-only history. */
const consentSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: CONSENT_PURPOSES, required: true },
    granted: { type: Boolean, required: true },
    documentVersion: String,
    ip: String,
    userAgent: String,
  },
  base,
);
consentSchema.index({ userId: 1, purpose: 1, createdAt: -1 });

const dataRequestSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['export', 'deletion'], required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'ready', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    resultKey: String,
    expiresAt: Date,
    error: String,
    completedAt: Date,
  },
  base,
);

export const OtpCode = model('OtpCode', otpSchema);
export const AuthToken = model('AuthToken', tokenSchema);
export const LegalDocument = model('LegalDocument', legalDocumentSchema);
export const Consent = model('Consent', consentSchema);
export const DataRequest = model('DataRequest', dataRequestSchema);
