import { Schema, model } from 'mongoose';
import { PREFERENCE_DIMENSIONS, PROFILE_STATUSES, PROFILE_STEPS } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const profileSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    /** Step data keyed by step name (basics, background, ...). Validated by the shared Zod schemas. */
    data: { type: Schema.Types.Mixed, default: {} },
    /** AES-256-GCM ciphertext for income and health notes. */
    sensitive: {
      incomeBandEnc: String,
      healthNotesEnc: String,
    },
    completedSteps: { type: [String], enum: PROFILE_STEPS, default: [] },
    currentStep: { type: String, enum: PROFILE_STEPS, default: 'basics' },
    /** Optimistic-concurrency counter; every successful write increments it. */
    version: { type: Number, default: 0 },
    status: { type: String, enum: PROFILE_STATUSES, default: 'draft', index: true },
    reviewNotes: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: Schema.Types.ObjectId,
        message: String,
        stepKeys: [String],
      },
    ],
    birthYear: { type: Number, index: true },
    gender: String,
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },
    submittedAt: Date,
    approvedAt: Date,
  },
  base,
);
profileSchema.index({ geo: '2dsphere' }, { sparse: true });
profileSchema.index({ status: 1, gender: 1, birthYear: 1 });

const photoSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Raw upload key; deleted once the sanitized variants exist. */
    key: { type: String, required: true },
    variants: {
      sm: String,
      md: String,
      lg: String,
      blur: String,
    },
    contentType: String,
    sizeBytes: Number,
    /** When a process took this photo to resize it. Stops two of them working on one photo; an old claim counts as abandoned. */
    processingStartedAt: Date,
    width: Number,
    height: Number,
    isPrimary: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['awaiting_upload', 'processing', 'pending', 'approved', 'rejected', 'failed'],
      default: 'awaiting_upload',
      index: true,
    },
    hash: { type: String, index: true },
    moderation: {
      faceDetected: Boolean,
      nsfw: Boolean,
      provider: String,
    },
    rejectionReason: String,
    reviewedBy: Schema.Types.ObjectId,
    reviewedAt: Date,
  },
  base,
);
photoSchema.index({ userId: 1, order: 1 });

const preferenceItem = new Schema(
  {
    key: { type: String, enum: PREFERENCE_DIMENSIONS, required: true },
    values: { type: [String], default: [] },
    range: { min: Number, max: Number },
    type: { type: String, enum: ['must', 'flexible'], required: true },
    importance: { type: Number, min: 1, max: 3, default: 2 },
  },
  { _id: false },
);

const preferenceSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    dimensions: { type: [preferenceItem], default: [] },
    version: { type: Number, default: 0 },
  },
  base,
);

export const Profile = model('Profile', profileSchema);
export const Photo = model('Photo', photoSchema);
export const Preference = model('Preference', preferenceSchema);
