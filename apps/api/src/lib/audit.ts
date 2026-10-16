import type { Types } from 'mongoose';
import type { Request } from 'express';
import { AuditLog, Outbox, StateTransition } from '../models/core';

export interface AuditInput {
  action: string;
  actorId?: Types.ObjectId | string;
  actorRoles?: string[];
  subjectType?: string;
  subjectId?: string;
  before?: unknown;
  after?: unknown;
}

export async function audit(req: Request | undefined, input: AuditInput): Promise<void> {
  await AuditLog.create({
    ...(input as object),
    ip: req?.ip,
    userAgent: req?.get('user-agent')?.slice(0, 300),
    requestId: (req as { id?: string | number } | undefined)?.id?.toString(),
  });
}

export async function logTransition(
  entityType: string,
  entityId: string,
  from: string | undefined,
  to: string,
  actorId?: Types.ObjectId | string,
  reason?: string,
): Promise<void> {
  await StateTransition.create({ entityType, entityId, from, to, actorId, reason });
}

/** Domain events are written here and relayed to BullMQ by the worker. */
export async function emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  await Outbox.create({ eventType, payload });
}
