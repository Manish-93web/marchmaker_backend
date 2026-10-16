import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { CallSignal } from '../models/extras';
import { pendingFor } from './rtc';

const OPEN = new Map<string, number>();

const frame = (s: { callId: unknown; kind: string; payload?: unknown }) =>
  `event: signal\ndata: ${JSON.stringify({ callId: String(s.callId), kind: s.kind, payload: s.payload ?? null })}\n\n`;

/** Delivers signalling messages addressed to the caller as server-sent events, replaying the last minute on connect. */
export async function streamCallSignals(req: Request, res: Response, introId: string, userId: string) {
  if ((OPEN.get(userId) ?? 0) >= 3) {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many open tabs', requestId: String(req.id) } });
    return;
  }
  OPEN.set(userId, (OPEN.get(userId) ?? 0) + 1);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  for (const s of await pendingFor(userId, introId)) res.write(frame(s));
  const watcher = CallSignal.watch(
    [{ $match: { operationType: 'insert', 'fullDocument.to': new Types.ObjectId(userId), 'fullDocument.introductionId': new Types.ObjectId(introId) } }],
    { fullDocument: 'default' },
  );
  watcher.on('change', (c) => {
    const doc = (c as { fullDocument?: { callId: unknown; kind: string; payload?: unknown } }).fullDocument;
    if (doc && !res.writableEnded) res.write(frame(doc));
  });
  watcher.on('error', () => res.end());
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 20_000);
  req.on('close', () => {
    clearInterval(beat);
    void watcher.close().catch(() => undefined);
    const n = (OPEN.get(userId) ?? 1) - 1;
    if (n <= 0) OPEN.delete(userId);
    else OPEN.set(userId, n);
  });
}
