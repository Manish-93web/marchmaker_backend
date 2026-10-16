import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { TicketMessage } from '../models/safety';

const OPEN = new Map<string, number>();
const MAX_PER_USER = 5;

/**
 * Pushes a "new message" signal while a member has a ticket open. The event carries no text, only that
 * something changed; the page then refetches through the normal authorised endpoint, so a stream can
 * never leak an internal note.
 */
export async function streamTicket(req: Request, res: Response, ticketId: string, userId: string) {
  if ((OPEN.get(userId) ?? 0) >= MAX_PER_USER) {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many open tabs', requestId: String(req.id) } });
    return;
  }
  OPEN.set(userId, (OPEN.get(userId) ?? 0) + 1);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  const watcher = TicketMessage.watch([{ $match: { operationType: 'insert', 'fullDocument.ticketId': new Types.ObjectId(ticketId), 'fullDocument.internal': false } }]);
  watcher.on('change', () => {
    if (!res.writableEnded) res.write('event: message\ndata: {}\n\n');
  });
  watcher.on('error', () => res.end());
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 25_000);
  req.on('close', () => {
    clearInterval(beat);
    void watcher.close().catch(() => undefined);
    const n = (OPEN.get(userId) ?? 1) - 1;
    if (n <= 0) OPEN.delete(userId);
    else OPEN.set(userId, n);
  });
}
