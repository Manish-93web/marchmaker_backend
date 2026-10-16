import { Schema, model } from 'mongoose';
import { ASSESSMENT_KEYS } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Versioned question bank. Editing publishes a new version; old responses keep their version. */
const definitionSchema = new Schema(
  {
    schemaVersion,
    key: { type: String, enum: ASSESSMENT_KEYS, required: true },
    version: { type: Number, required: true },
    title: { type: String, required: true },
    description: String,
    minutes: Number,
    dimensions: [String],
    /** QuestionDef[] including scoring data. Never returned to members as-is. */
    questions: { type: Schema.Types.Mixed, required: true },
    active: { type: Boolean, default: true },
    publishedAt: { type: Date, default: Date.now },
    publishedBy: Schema.Types.ObjectId,
  },
  base,
);
definitionSchema.index({ key: 1, version: -1 }, { unique: true });

const responseSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, enum: ASSESSMENT_KEYS, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    answers: { type: Schema.Types.Mixed, default: {} },
    /** Internal only: dimension -> 0..1. Visible to staff, never to the member. */
    dimensionScores: { type: Schema.Types.Mixed },
    bands: { type: Schema.Types.Mixed },
    narrative: { type: Schema.Types.Mixed },
    completedAt: Date,
    retakeAvailableAt: Date,
  },
  base,
);
responseSchema.index({ userId: 1, key: 1, createdAt: -1 });
// At most one attempt in progress per member and assessment.
responseSchema.index(
  { userId: 1, key: 1 },
  { unique: true, partialFilterExpression: { status: 'in_progress' } },
);

export const AssessmentDefinition = model('AssessmentDefinition', definitionSchema);
export const AssessmentResponse = model('AssessmentResponse', responseSchema);
