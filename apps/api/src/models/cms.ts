import { Schema, model } from 'mongoose';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const faqSchema = new Schema(
  {
    schemaVersion,
    question: { type: String, required: true, maxlength: 240 },
    /** Markdown, rendered safely on the site. */
    answer: { type: String, required: true, maxlength: 4000 },
    category: { type: String, maxlength: 40, index: true },
    sortOrder: { type: Number, default: 0 },
    published: { type: Boolean, default: false, index: true },
    updatedBy: Schema.Types.ObjectId,
  },
  base,
);

/** A staff member's own saved filter for a list (members for now). */
const savedFilterSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    scope: { type: String, enum: ['members'], default: 'members' },
    name: { type: String, required: true, maxlength: 60 },
    query: { type: Schema.Types.Mixed, required: true },
  },
  base,
);
savedFilterSchema.index({ userId: 1, scope: 1, name: 1 }, { unique: true });

export const Faq = model('Faq', faqSchema);
export const SavedFilter = model('SavedFilter', savedFilterSchema);
