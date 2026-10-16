import type { Types } from 'mongoose';
import { emit } from '../lib/audit';
import { Message, MessageThread } from '../models/social';

const HOUR = 3_600_000;

/**
 * At most one email a day to a member who has had unread messages sitting for two hours or more.
 * It carries only a count, never the words. The notification's source id includes the day, so running
 * the sweep again (or on two workers) cannot send a second one.
 */
export async function sendMessageDigests(now = new Date()): Promise<number> {
  const threads = await MessageThread.find({ status: 'open', lastMessageAt: { $gte: new Date(now.getTime() - 24 * HOUR), $lte: new Date(now.getTime() - 2 * HOUR) } })
    .select('members')
    .limit(1000)
    .lean();
  const counts = new Map<string, number>();
  for (const t of threads) {
    for (const member of t.members) {
      const unread = await Message.countDocuments({ threadId: t._id, senderId: { $ne: member as Types.ObjectId }, readAt: { $exists: false }, createdAt: { $lte: new Date(now.getTime() - 2 * HOUR) } });
      if (unread) counts.set(String(member), (counts.get(String(member)) ?? 0) + unread);
    }
  }
  const day = now.toISOString().slice(0, 10);
  for (const [userId, count] of counts) await emit('message.digest', { userId, count, day });
  return counts.size;
}
