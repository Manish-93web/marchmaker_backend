import { Schema, model } from 'mongoose';
import { NOTIFICATION_CHANNELS } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

const notificationSchema = new Schema(
  {
    schemaVersion,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    category: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    url: { type: String, required: true },
    /** At-least-once events are de-duplicated on (user, type, source). */
    sourceId: { type: String, required: true },
    /** Messages in one conversation collapse into a single unread row. */
    groupKey: String,
    count: { type: Number, default: 1 },
    readAt: Date,
  },
  base,
);
notificationSchema.index({ userId: 1, type: 1, sourceId: 1 }, { unique: true });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, groupKey: 1, readAt: 1 });

const deliverySchema = new Schema(
  {
    schemaVersion,
    notificationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped'], default: 'queued', index: true },
    /** The provider's message id, to match delivery events. */
    providerId: { type: String, index: true, sparse: true },
    deliveredAt: Date,
    reason: String,
    sendAfter: { type: Date, default: Date.now, index: true },
    attempts: { type: Number, default: 0 },
    sentAt: Date,
    error: String,
  },
  base,
);
deliverySchema.index({ notificationId: 1, channel: 1 }, { unique: true });

const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: String,
  },
  base,
);

export const Notification = model('Notification', notificationSchema);
export const Delivery = model('NotificationDelivery', deliverySchema);
export const PushSubscription = model('PushSubscription', pushSubscriptionSchema);
