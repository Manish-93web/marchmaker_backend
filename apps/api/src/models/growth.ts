import { Schema, model } from 'mongoose';
import { ANALYTICS_EVENTS, FEEDBACK_STAGES, FEEDBACK_TAGS } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Consent-gated product analytics. No names, emails or free text; kept 13 months. */
const analyticsEventSchema = new Schema(
  {
    name: { type: String, enum: ANALYTICS_EVENTS, required: true },
    anonId: { type: String, required: true },
    /** Keyed hash of the member id, only present when a signed-in member has consented. */
    uid: String,
    props: Schema.Types.Mixed,
    at: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
analyticsEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
analyticsEventSchema.index({ name: 1, at: -1 });

/** One row per member per day they signed in or refreshed a session, for retention. */
const activeDaySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
activeDaySchema.index({ userId: 1, day: 1 }, { unique: true });
activeDaySchema.index({ day: 1 });
activeDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const introFeedbackSchema = new Schema(
  {
    schemaVersion,
    introductionId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    stage: { type: String, enum: FEEDBACK_STAGES, default: 'checkin' },
    rating: { type: Number, min: 1, max: 5 },
    met: Boolean,
    tags: [{ type: String, enum: FEEDBACK_TAGS }],
    note: String,
  },
  base,
);
introFeedbackSchema.index({ introductionId: 1, userId: 1, stage: 1 }, { unique: true });

const checkinMarkerSchema = new Schema(
  { introductionId: { type: Schema.Types.ObjectId, required: true }, userId: { type: Schema.Types.ObjectId, required: true }, stage: { type: String, default: 'checkin' } },
  { versionKey: false, timestamps: true },
);
checkinMarkerSchema.index({ introductionId: 1, userId: 1, stage: 1 }, { unique: true });

const experimentSchema = new Schema(
  {
    schemaVersion,
    key: { type: String, required: true, unique: true },
    description: String,
    enabled: { type: Boolean, default: false },
    variants: [{ _id: false, name: String, weight: Number }],
    updatedBy: Schema.Types.ObjectId,
  },
  base,
);

export const AnalyticsEvent = model('AnalyticsEvent', analyticsEventSchema);
export const ActiveDay = model('ActiveDay', activeDaySchema);
export const IntroFeedback = model('IntroFeedback', introFeedbackSchema);
export const CheckinMarker = model('CheckinMarker', checkinMarkerSchema);
export const Experiment = model('Experiment', experimentSchema);
