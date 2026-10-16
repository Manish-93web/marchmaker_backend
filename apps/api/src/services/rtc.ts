import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { CALL_DAILY_LIMIT, RTC_MAX_PAYLOAD_BYTES, callWindowOpen, type RtcSignalKind } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AppError, conflict, notFound } from '../lib/errors';
import { CallLog, CallSignal } from '../models/extras';
import { load, other } from './introductions';

const sid = (v: unknown) => String(v);
const DAY = 86_400_000;
const RING_TIMEOUT_MS = 60_000;

/** STUN plus, when configured, TURN with credentials that expire (the coturn "REST API" scheme). */
export function iceServers(ctx: AppContext, userId: string, now = Date.now()) {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [{ urls: ctx.env.RTC_STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean) }];
  if (ctx.env.RTC_TURN_URLS && ctx.env.RTC_TURN_SECRET) {
    const expires = Math.floor(now / 1000) + ctx.env.RTC_TURN_TTL_SEC;
    const username = `${expires}:${userId}`;
    const credential = createHmac('sha1', ctx.env.RTC_TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: ctx.env.RTC_TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean), username, credential });
  }
  return { iceServers: servers, expiresInSec: ctx.env.RTC_TURN_TTL_SEC };
}

async function eligible(introId: string, userId: string) {
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw conflict('Voice calls open once you have both accepted');
  const me = intro.members.find((m) => sid(m.userId) === userId)!;
  const o = other(intro, userId);
  if (!me.voiceOptIn || !o.voiceOptIn) throw new AppError(409, 'VOICE_NOT_AGREED', 'Calls need both of you to say you are open to them');
  return { intro, otherId: sid(o.userId) };
}

/** Starts an in-app call: checks the same rules as a phone call, records it and tells the other person. */
export async function startRtcCall(ctx: AppContext, introId: string, userId: string, now = new Date()) {
  const { intro, otherId } = await eligible(introId, userId);
  if (!callWindowOpen(now)) throw new AppError(409, 'OUTSIDE_CALL_HOURS', 'Calls can be placed between 9 am and 9 pm India time');
  const recent = await CallLog.countDocuments({ introductionId: intro._id, createdAt: { $gte: new Date(now.getTime() - DAY) } });
  if (recent >= CALL_DAILY_LIMIT) throw new AppError(429, 'CALL_LIMIT', 'You have reached the daily call limit for this introduction');
  const live = await CallLog.exists({ introductionId: intro._id, mode: 'webrtc', status: { $in: ['ringing', 'in_progress'] }, createdAt: { $gte: new Date(now.getTime() - 4 * 3_600_000) } });
  if (live) throw conflict('A call is already in progress');
  const log = await CallLog.create({ introductionId: intro._id, initiatedBy: userId, mode: 'webrtc', status: 'ringing' });
  await CallSignal.create({ callId: log._id, introductionId: intro._id, from: userId, to: otherId, kind: 'invite' });
  return { callId: sid(log._id), ...iceServers(ctx, userId), remainingToday: Math.max(0, CALL_DAILY_LIMIT - recent - 1) };
}

export async function rtcConfig(ctx: AppContext, introId: string, userId: string) {
  await eligible(introId, userId);
  return iceServers(ctx, userId);
}

/** Relays one signalling message to the other person and keeps the call record in step. */
export async function signal(introId: string, userId: string, input: { callId: string; kind: RtcSignalKind; payload?: Record<string, unknown> }, now = new Date()) {
  const { intro, otherId } = await eligible(introId, userId);
  if (input.payload && Buffer.byteLength(JSON.stringify(input.payload)) > RTC_MAX_PAYLOAD_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'That message is too large');
  const log = await CallLog.findOne({ _id: input.callId, introductionId: intro._id, mode: 'webrtc' });
  if (!log) throw notFound();
  if (['completed', 'no_answer', 'failed', 'busy'].includes(log.status)) throw conflict('This call has ended');

  if (input.kind === 'accept') {
    if (sid(log.initiatedBy) === userId) throw conflict('Only the person being called can accept');
    log.status = 'in_progress';
    log.startedAt = now;
  } else if (input.kind === 'decline') {
    log.status = 'busy';
    log.endedAt = now;
  } else if (input.kind === 'end') {
    log.endedAt = now;
    if (log.startedAt) {
      log.status = 'completed';
      log.durationSec = Math.min(Math.round((now.getTime() - log.startedAt.getTime()) / 1000), 4 * 3600);
    } else {
      log.status = 'no_answer';
    }
  }
  if (log.isModified()) await log.save();
  await CallSignal.create({ callId: log._id, introductionId: intro._id, from: userId, to: otherId, kind: input.kind, payload: input.payload });
  return { ok: true as const };
}

/** A call nobody answered within a minute is closed by the sweep, so it cannot block the next one. */
export async function closeUnanswered(now = new Date()) {
  const r = await CallLog.updateMany({ mode: 'webrtc', status: 'ringing', createdAt: { $lt: new Date(now.getTime() - RING_TIMEOUT_MS) } }, { $set: { status: 'no_answer', endedAt: now } });
  return r.modifiedCount;
}

/** Signals addressed to me in the last minute, oldest first; used when the stream connects. */
export async function pendingFor(userId: string, introId: string, now = new Date()) {
  return CallSignal.find({ to: new Types.ObjectId(userId), introductionId: introId, createdAt: { $gte: new Date(now.getTime() - 60_000) } }).sort({ createdAt: 1 }).lean();
}
