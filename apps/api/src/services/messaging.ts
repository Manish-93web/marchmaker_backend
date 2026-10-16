import { Types } from 'mongoose';
import { messageProblems } from '@marchmaker/shared';
import { emit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Block } from '../models/matching';
import { Message, MessageThread } from '../models/social';

const sid = (v: unknown) => String(v);

async function thread(threadId: string, userId: string) {
  if (!Types.ObjectId.isValid(threadId)) throw notFound('Conversation not found');
  const t = await MessageThread.findOne({ _id: threadId, members: userId });
  if (!t) throw notFound('Conversation not found');
  return t;
}

const otherOf = (t: { members: unknown[] }, userId: string): string => sid(t.members.find((m) => sid(m) !== userId));

async function isBlocked(a: string, b: string): Promise<boolean> {
  return !!(await Block.exists({
    $or: [
      { blockerId: a, blockedId: b },
      { blockerId: b, blockedId: a },
    ],
  }));
}

export async function listThreads(userId: string) {
  const threads = await MessageThread.find({ members: userId }).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(50).lean();
  const out = [];
  for (const t of threads) {
    const otherId = otherOf(t, userId);
    if (await isBlocked(userId, otherId)) continue;
    const u = await User.findById(otherId).select('firstName').lean();
    const lastRead = ((t.lastRead ?? {}) as Record<string, string | undefined>)[userId];
    const unread = await Message.countDocuments({
      threadId: t._id,
      senderId: { $ne: userId },
      ...(lastRead ? { createdAt: { $gt: new Date(lastRead) } } : {}),
    });
    out.push({
      id: sid(t._id),
      introductionId: sid(t.introductionId),
      with: { id: otherId, firstName: u?.firstName ?? '' },
      status: t.status,
      lastMessageAt: t.lastMessageAt ?? null,
      lastMessagePreview: t.lastMessagePreview ?? null,
      unread,
    });
  }
  return out;
}

export async function messages(threadId: string, userId: string, before?: string, limit = 50) {
  const t = await thread(threadId, userId);
  const otherId = otherOf(t, userId);
  if (await isBlocked(userId, otherId)) throw notFound('Conversation not found');
  const filter: Record<string, unknown> = { threadId: t._id };
  if (before && Types.ObjectId.isValid(before)) filter._id = { $lt: new Types.ObjectId(before) };
  const rows = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit).reverse();
  const u = await User.findById(otherId).select('firstName').lean();
  return {
    status: t.status,
    introductionId: sid(t.introductionId),
    with: { id: otherId, firstName: u?.firstName ?? '' },
    items: page.map((m) => ({
      id: sid(m._id),
      mine: sid(m.senderId) === userId,
      body: m.body,
      at: m.createdAt,
      readAt: m.readAt ?? null,
    })),
    hasMore: rows.length > limit,
  };
}

export async function send(threadId: string, userId: string, body: string, clientId?: string) {
  const t = await thread(threadId, userId);
  const otherId = otherOf(t, userId);
  // A block hides the conversation entirely, so it is checked before the thread state.
  if (await isBlocked(userId, otherId)) throw notFound('Conversation not found');
  if (t.status !== 'open') throw conflict('This conversation has ended');

  const problems = messageProblems(body);
  if (problems.length) throw new AppError(422, 'MESSAGE_INVALID', problems[0]!, { problems });

  let msg;
  try {
    msg = await Message.create({ threadId: t._id, senderId: userId, body: body.trim(), clientId });
  } catch (err) {
    // The same client id twice means a retry: return the original instead of a duplicate.
    if ((err as { code?: number }).code === 11000 && clientId) {
      const dup = await Message.findOne({ threadId: t._id, clientId });
      if (dup) return { id: sid(dup._id), at: dup.createdAt, duplicate: true };
    }
    throw err;
  }
  await MessageThread.updateOne(
    { _id: t._id },
    {
      $set: {
        lastMessageAt: msg.createdAt,
        lastMessagePreview: body.trim().slice(0, 80),
        [`lastRead.${userId}`]: msg.createdAt.toISOString(),
      },
    },
  );
  await emit('message.created', { userId: otherId, threadId, messageId: sid(msg._id) });
  return { id: sid(msg._id), at: msg.createdAt, duplicate: false };
}

export async function markRead(threadId: string, userId: string) {
  const t = await thread(threadId, userId);
  const now = new Date();
  await MessageThread.updateOne({ _id: t._id }, { $set: { [`lastRead.${userId}`]: now.toISOString() } });
  await Message.updateMany(
    { threadId: t._id, senderId: { $ne: userId }, readAt: { $exists: false } },
    { $set: { readAt: now } },
  );
}
