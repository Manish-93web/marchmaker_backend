import type { Types } from 'mongoose';
import { ActiveDay } from '../models/growth';

/** India calendar day, so "daily active" matches how members experience a day. */
export const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Records that a member was active today. Cheap, idempotent and never allowed to break sign-in. */
export async function markActive(userId: Types.ObjectId | string): Promise<void> {
  try {
    await ActiveDay.updateOne(
      { userId, day: istDay() },
      { $setOnInsert: { expiresAt: new Date(Date.now() + 800 * 86_400_000) } },
      { upsert: true },
    );
  } catch {
    // A concurrent insert or a brief outage must not affect the caller.
  }
}
