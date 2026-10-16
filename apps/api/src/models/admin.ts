import { Schema, model } from 'mongoose';
import { ROLES } from '@marchmaker/shared';

const base = { timestamps: true, versionKey: false } as const;
const schemaVersion = { type: Number, default: 1 } as const;

/** Editable role -> permission mapping. Roles without a row use the seeded defaults. */
const rolePermissionSchema = new Schema(
  {
    schemaVersion,
    role: { type: String, enum: ROLES, required: true, unique: true },
    permissions: { type: [String], default: [] },
    updatedBy: Schema.Types.ObjectId,
  },
  base,
);

const adminNoteSchema = new Schema(
  {
    schemaVersion,
    subjectUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 2000 },
    pinned: { type: Boolean, default: false },
  },
  base,
);
adminNoteSchema.index({ subjectUserId: 1, pinned: -1, createdAt: -1 });

export const RolePermission = model('RolePermission', rolePermissionSchema);
export const AdminNote = model('AdminNote', adminNoteSchema);
