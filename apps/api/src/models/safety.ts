import { Schema, model } from 'mongoose';
import {
  APPEAL_STATUSES,
  MODERATION_ACTIONS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Immutable history of what staff did about a member, used for repeat-offender signals. */
const moderationActionSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    reportId: { type: Schema.Types.ObjectId, index: true },
    action: { type: String, enum: MODERATION_ACTIONS, required: true },
    reason: { type: String, required: true },
    memberMessage: String,
    by: { type: Schema.Types.ObjectId, required: true },
  },
  base,
);

const appealSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    message: { type: String, required: true },
    status: { type: String, enum: APPEAL_STATUSES, default: 'pending', index: true },
    decidedBy: Schema.Types.ObjectId,
    decidedAt: Date,
    note: String,
    /** Status the account had when the appeal was filed, for the reviewer. */
    accountStatus: String,
    moderationReason: String,
  },
  base,
);

const ticketSchema = new Schema(
  {
    schemaVersion,
    number: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, index: true },
    email: { type: String, required: true },
    name: String,
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    subject: { type: String, required: true },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    status: { type: String, enum: TICKET_STATUSES, default: 'open', index: true },
    assigneeId: { type: Schema.Types.ObjectId, index: true },
    firstResponseDueAt: { type: Date, index: true },
    firstResponseAt: Date,
    lastMessageAt: { type: Date, default: Date.now },
    lastMessageBy: { type: String, enum: ['member', 'staff'] },
    resolvedAt: Date,
    slaAlertedAt: Date,
    csat: { rating: Number, comment: String, at: Date, _id: false },
  },
  base,
);
ticketSchema.index({ status: 1, firstResponseDueAt: 1 });

const ticketMessageSchema = new Schema(
  {
    ticketId: { type: Schema.Types.ObjectId, required: true, index: true },
    author: { type: String, enum: ['member', 'staff', 'system'], required: true },
    authorId: Schema.Types.ObjectId,
    body: { type: String, required: true },
    /** Internal notes are never shown to the member. */
    internal: { type: Boolean, default: false },
    attachments: [{ _id: false, key: String, name: String, contentType: String, size: Number }],
  },
  base,
);

const cannedSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    createdBy: Schema.Types.ObjectId,
  },
  base,
);

export const ModerationAction = model('ModerationAction', moderationActionSchema);
export const Appeal = model('Appeal', appealSchema);
export const Ticket = model('Ticket', ticketSchema);
export const TicketMessage = model('TicketMessage', ticketMessageSchema);
export const CannedReply = model('CannedReply', cannedSchema);
