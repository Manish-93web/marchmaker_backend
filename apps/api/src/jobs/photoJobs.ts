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
  const photo = await Photo.findOneAndUpdate(
    { _id: photoId, status: 'processing' },
    { $set: { status: 'processing' } },
  );
  if (!photo) return; // already processed, or deleted meanwhile

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
