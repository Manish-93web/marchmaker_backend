import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AppContext } from '../context';
import { Photo } from '../models/profile';
import { photoKey } from '../services/photos';

const VARIANTS = [
  { name: 'sm', width: 320 },
  { name: 'md', width: 800 },
  { name: 'lg', width: 1600 },
] as const;

/**
 * Sanitises an uploaded photo: re-encodes to WebP (which drops EXIF, GPS and any embedded
 * payload), creates three sizes plus a heavily blurred preview, detects duplicates, runs the
 * moderation adapter, then deletes the raw upload. The photo then waits for human approval.
 */
export async function processPhoto(ctx: AppContext, photoId: string): Promise<void> {
  // Claim the photo so that the worker, the API's own recovery pass and a retry never resize the same one at once.
  // A claim older than five minutes is treated as abandoned (the process that took it stopped).
  const photo = await Photo.findOneAndUpdate(
    {
      _id: photoId,
      status: 'processing',
      $or: [{ processingStartedAt: { $exists: false } }, { processingStartedAt: null }, { processingStartedAt: { $lt: new Date(Date.now() - 5 * 60_000) } }],
    },
    { $set: { processingStartedAt: new Date() } },
  );
  if (!photo) return; // already processed, being processed, or deleted meanwhile

  const userId = String(photo.userId);
  try {
    const original = await ctx.storage.get('photos', photo.key);
    const meta = await sharp(original).metadata();
    if (!meta.width || !meta.height) throw new Error('unreadable image');
    if (meta.width < 200 || meta.height < 200) {
      await Photo.updateOne({ _id: photoId }, { $set: { status: 'rejected', rejectionReason: 'too_small' } });
      await ctx.storage.delete('photos', photo.key).catch(() => undefined);
      return;
    }

    const base = sharp(original, { failOn: 'error' }).rotate(); // auto-orient, then metadata is dropped on output
    const keys: Record<string, string> = {};
    let mdBuffer: Buffer | undefined;

    for (const v of VARIANTS) {
      const out = await base
        .clone()
        .resize({ width: v.width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const key = photoKey(userId, photoId, `${v.name}.webp`);
      await ctx.storage.put('photos', key, out, 'image/webp');
      keys[v.name] = key;
      if (v.name === 'md') mdBuffer = out;
    }

    const blurred = await base.clone().resize({ width: 24 }).blur(1.2).webp({ quality: 40 }).toBuffer();
    const blurKey = photoKey(userId, photoId, 'blur.webp');
    await ctx.storage.put('photos', blurKey, blurred, 'image/webp');
    keys.blur = blurKey;

    const hash = createHash('sha256').update(mdBuffer ?? original).digest('hex');
    const duplicate = await Photo.exists({
      userId,
      hash,
      _id: { $ne: photoId },
      status: { $in: ['pending', 'approved'] },
    });
    const check = await ctx.moderation.check(mdBuffer ?? original);

    const rejected = duplicate ? 'duplicate' : check.nsfw === true ? 'nsfw' : undefined;
    await Photo.updateOne(
      { _id: photoId },
      {
        $set: {
          variants: keys,
          hash,
          width: meta.width,
          height: meta.height,
          moderation: {
            faceDetected: check.faceDetected ?? undefined,
            nsfw: check.nsfw ?? undefined,
            provider: check.provider,
          },
          status: rejected ? 'rejected' : 'pending',
          ...(rejected && { rejectionReason: rejected }),
        },
      },
    );
    await ctx.storage.delete('photos', photo.key).catch(() => undefined);
  } catch (err) {
    ctx.log.error({ err, photoId }, 'photo processing failed');
    await Photo.updateOne({ _id: photoId }, { $set: { status: 'failed', rejectionReason: 'processing_error' } });
    throw err;
  }
}

/**
 * Processes photos that have waited too long in "processing". This is the safety net for deployments without a job
 * queue: the API runs it on a timer, so a photo never stays stuck if the worker is slow, down or not running.
 */
export async function processStuckPhotos(ctx: AppContext, olderThanMs = 90_000, limit = 5): Promise<number> {
  const stuck = await Photo.find({ status: 'processing', updatedAt: { $lt: new Date(Date.now() - olderThanMs) } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  let done = 0;
  for (const p of stuck) {
    try {
      await processPhoto(ctx, String(p._id));
      done++;
    } catch (err) {
      ctx.log.warn({ err, photoId: String(p._id) }, 'stuck photo could not be processed');
    }
  }
  return done;
}
