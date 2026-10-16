import { randomUUID } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AppError } from '../lib/errors';

export interface StoredAttachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
}

type Scope = 'ticket' | 'report';

/** Private uploads go straight to the documents bucket; the key carries the owner so nobody can attach someone else's file. */
export async function presign(ctx: AppContext, userId: string, input: { scope: Scope; contentType: keyof typeof ATTACHMENT_TYPES; size: number; name: string }) {
  const ext = ATTACHMENT_TYPES[input.contentType];
  if (input.scope === 'report' && ext === 'pdf') throw new AppError(422, 'VALIDATION_ERROR', 'Please attach a screenshot (PNG, JPG or WebP)');
  const key = `attachments/${input.scope}/${userId}/${randomUUID()}.${ext}`;
  const upload = await ctx.storage.presignPut('documents', key, input.contentType, input.size, 600);
  return { key, upload, maxBytes: ATTACHMENT_MAX_BYTES };
}

/** Confirms each key belongs to this member and really was uploaded within the limits. */
export async function confirm(ctx: AppContext, userId: string, scope: Scope, keys: string[]): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  for (const key of [...new Set(keys)]) {
    if (!key.startsWith(`attachments/${scope}/${userId}/`)) throw new AppError(422, 'VALIDATION_ERROR', 'That attachment is not valid');
    const head = await ctx.storage.head('documents', key);
    if (!head) throw new AppError(422, 'VALIDATION_ERROR', 'An attachment did not finish uploading');
    if (head.size > ATTACHMENT_MAX_BYTES) throw new AppError(422, 'VALIDATION_ERROR', 'An attachment is too large (5 MB maximum)');
    const ext = key.split('.').pop() as string;
    const contentType = Object.entries(ATTACHMENT_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    out.push({ key, name: key.split('/').pop() as string, contentType, size: head.size });
  }
  return out;
}

export async function withUrls(ctx: AppContext, items: StoredAttachment[] | undefined) {
  return Promise.all((items ?? []).map(async (a) => ({ name: a.name, contentType: a.contentType, size: a.size, url: await ctx.storage.presignGet('documents', a.key, 300) })));
}
