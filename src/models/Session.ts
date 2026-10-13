import mongoose, { Schema, Document, Types } from "mongoose";

export interface ISession extends Document {
  userId: Types.ObjectId;
  token: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  isValid: boolean;
  createdAt: Date;
}

const SessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userAgent: {
      type: String,
    },
    ipAddress: {
      type: String,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL index to automatically purge expired sessions
    },
    isValid: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

SessionSchema.index({ userId: 1, isValid: 1 });

export const Session = mongoose.model<ISession>("Session", SessionSchema);
