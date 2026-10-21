import { randomUUID } from 'node:crypto';
import { DEFAULTS, PHOTO_MAX_BYTES } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { emit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { Photo } from '../models/profile';

const ACTIVE = ['awaiting_upload', 'processing', 'pending', 'approved'] as const;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const photoKey = (userId: string, photoId: string, name: string) => `photos/${userId}/${photoId}/${name}`;

export async function createUpload(
  ctx: AppContext,
  userId: string,
  input: { contentType: string; sizeBytes: number },
) {
  if (input.sizeBytes > PHOTO_MAX_BYTES) throw badRequest('That photo is too large (10 MB maximum)');
  const live = await Photo.countDocuments({ userId, status: { $in: ACTIVE } });
  if (live >= DEFAULTS.maxPhotos) throw conflict(`You can add up to ${DEFAULTS.maxPhotos} photos`);

  const id = randomUUID();
  const key = photoKey(userId, id, `original.${EXT[input.contentType] ?? 'bin'}`);
  const photo = await Photo.create({
    userId,
    key,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    status: 'awaiting_upload',
    order: live,
    isPrimary: live === 0,
  });
  const put = await ctx.storage.presignPut('photos', key, input.contentType, input.sizeBytes, DEFAULTS.signedUrlTtlSec);
  return { id: String(photo._id), upload: put };
}

/** Called after the browser has PUT the file. Verifies the object, then hands it to the worker. */
export async function confirmUpload(ctx: AppContext, userId: string, id: string) {
  const photo = await Photo.findOne({ _id: id, userId });
  if (!photo) throw notFound('Photo not found');
  if (photo.status !== 'awaiting_upload') return { id, status: photo.status };

  const head = await ctx.storage.head('photos', photo.key);
  if (!head) throw badRequest('We have not received that photo yet. Please try uploading again.');
  if (head.size > PHOTO_MAX_BYTES || (photo.sizeBytes && head.size !== photo.sizeBytes)) {
    await ctx.storage.delete('photos', photo.key).catch(() => undefined);
    await Photo.updateOne({ _id: id }, { $set: { status: 'failed', rejectionReason: 'size_mismatch' } });
    throw badRequest('That upload did not match the file you selected. Please try again.');
  }

  const claimed = await Photo.findOneAndUpdate(
    { _id: id, status: 'awaiting_upload' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  );
  if (claimed) await emit('photo.uploaded', { photoId: id, userId });
  // Without a job queue (no REDIS_URL) nothing else would pick this up, so the API resizes it itself, right after replying.
  if (claimed && ctx.env.NODE_ENV !== 'test' && !ctx.env.REDIS_URL) {
    void import('../jobs/photoJobs')
      .then((m) => m.processPhoto(ctx, id))
      .catch((err) => ctx.log.warn({ err, photoId: id }, 'inline photo processing failed'));
  }
  return { id, status: 'processing' as const };
}

export async function listOwnPhotos(ctx: AppContext, userId: string) {
  const rows = await Photo.find({ userId, status: { $in: ['processing', 'pending', 'approved', 'rejected'] } })
    .sort({ order: 1 })
    .lean();
  return Promise.all(
    rows.map(async (p) => ({
      id: String(p._id),
      status: p.status,
      isPrimary: p.isPrimary,
      order: p.order,
      rejectionReason: p.rejectionReason ?? null,
      // Short-lived links; the browser asks again when they expire.
      sm: p.variants?.sm ? await ctx.storage.presignGet('photos', p.variants.sm, DEFAULTS.signedUrlTtlSec) : null,
      md: p.variants?.md ? await ctx.storage.presignGet('photos', p.variants.md, DEFAULTS.signedUrlTtlSec) : null,
    })),
  );
}

export async function setPrimary(userId: string, id: string) {
  const photo = await Photo.findOne({ _id: id, userId, status: { $in: ['pending', 'approved'] } });
  if (!photo) throw notFound('Photo not found');
  await Photo.updateMany({ userId }, { $set: { isPrimary: false } });
  await Photo.updateOne({ _id: id }, { $set: { isPrimary: true } });
}

export async function reorder(userId: string, order: string[]) {
  const own = await Photo.find({ userId, status: { $in: ACTIVE } }).select('_id');
  const ownIds = new Set(own.map((p) => String(p._id)));
  if (order.length !== ownIds.size || !order.every((id) => ownIds.has(id)) || new Set(order).size !== order.length) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Send every photo exactly once');
  }
  await Photo.bulkWrite(order.map((id, i) => ({ updateOne: { filter: { _id: id, userId }, update: { $set: { order: i } } } })));
}

export async function removePhoto(ctx: AppContext, userId: string, id: string) {
  const photo = await Photo.findOneAndDelete({ _id: id, userId });
  if (!photo) throw notFound('Photo not found');
  const keys = [photo.key, ...Object.values(photo.variants ?? {})].filter((k): k is string => typeof k === 'string');
  await Promise.all(keys.map((k) => ctx.storage.delete('photos', k).catch(() => undefined)));
  if (photo.isPrimary) {
    const next = await Photo.findOne({ userId, status: { $in: ACTIVE } }).sort({ order: 1 });
    if (next) await Photo.updateOne({ _id: next._id }, { $set: { isPrimary: true } });
  }
}

/** Purge hook payload: every storage key owned by a member. */
export async function allPhotoKeys(userId: string): Promise<string[]> {
  const rows = await Photo.find({ userId }).lean();
  return rows.flatMap((p) => [p.key, ...Object.values(p.variants ?? {})].filter((k): k is string => typeof k === 'string'));
}
