import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { guideAllowed, type GuideInput, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { Guide, GuideProgress } from '../models/content';
import { User } from '../models/core';

interface Actor {
  userId: string;
  roles: Role[];
}
const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };

async function planOf(userId?: string): Promise<string> {
  if (!userId) return 'free';
  const u = await User.findById(userId).select('plan').lean();
  return u?.plan?.planCode ?? 'free';
}

/** A guide a visitor may read in full gets its body; a premium one gets its summary and a clear reason. */
export async function read(slug: string, userId?: string) {
  const g = await Guide.findOne({ slug, published: true }).lean();
  if (!g) throw notFound();
  const access = g.access as 'free' | 'premium';
  const allowed = guideAllowed(access, await planOf(userId));
  return {
    slug: g.slug,
    title: g.title,
    summary: g.summary ?? '',
    category: g.category ?? null,
    access,
    allowed,
    // The transcript is the body: audio is never the only way to take in a guide.
    bodyMarkdown: allowed ? (g.bodyMarkdown ?? '') : null,
    hasAudio: !!g.audioKey,
    audioSeconds: g.audioSeconds ?? null,
    publishedAt: g.publishedAt ?? null,
  };
}

export const guideProgressSchema = z.object({
  positionSec: z.number().min(0).max(86_400).default(0),
  scrollPct: z.number().min(0).max(100).default(0),
  speed: z.number().min(0.5).max(2).default(1),
  completed: z.boolean().default(false),
});

export async function getProgress(userId: string, slug: string) {
  const p = await GuideProgress.findOne({ userId, slug }).lean();
  return { positionSec: p?.positionSec ?? 0, scrollPct: p?.scrollPct ?? 0, speed: p?.speed ?? 1, completed: p?.completed ?? false };
}

export async function saveProgress(userId: string, slug: string, input: z.infer<typeof guideProgressSchema>) {
  if (!(await Guide.exists({ slug, published: true }))) throw notFound();
  await GuideProgress.updateOne({ userId, slug }, { $set: input }, { upsert: true });
  return input;
}

export async function audioUrl(ctx: AppContext, slug: string, userId?: string) {
  const g = await Guide.findOne({ slug, published: true }).lean();
  if (!g?.audioKey) throw notFound();
  if (!guideAllowed(g.access as 'free' | 'premium', await planOf(userId))) {
    throw new AppError(402, 'PREMIUM_ONLY', 'This audio is part of the Premium plan');
  }
  return { url: await ctx.storage.presignGet('documents', g.audioKey, 3600), expiresInSec: 3600 };
}

// ------------------------------------------------------------------ staff

export async function adminList() {
  const rows = await Guide.find().sort({ updatedAt: -1 }).limit(200).lean();
  return {
    items: rows.map((g) => ({
      slug: g.slug,
      title: g.title,
      summary: g.summary ?? '',
      category: g.category ?? null,
      access: g.access,
      published: g.published,
      hasAudio: !!g.audioKey,
      audioSeconds: g.audioSeconds ?? null,
      bodyMarkdown: g.bodyMarkdown ?? '',
      updatedAt: g.updatedAt,
    })),
  };
}

export async function upsert(req: Request, input: GuideInput, actor: Actor) {
  const before = await Guide.findOne({ slug: input.slug }).select('published').lean();
  const set: Record<string, unknown> = {
    title: input.title,
    summary: input.summary,
    category: input.category,
    bodyMarkdown: input.bodyMarkdown,
    access: input.access,
    published: input.published,
  };
  if (input.published && !before?.published) set.publishedAt = new Date();
  await Guide.updateOne({ slug: input.slug }, { $set: set }, { upsert: true });
  await audit(req, {
    action: before ? 'guide.updated' : 'guide.created',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'guide',
    subjectId: input.slug,
    after: { published: input.published, access: input.access },
  });
  return { slug: input.slug };
}

export async function requestAudioUpload(ctx: AppContext, slug: string, input: { contentType: string; sizeBytes: number; seconds: number }) {
  if (!(await Guide.exists({ slug }))) throw notFound();
  const key = `guides/${slug}/${randomUUID()}.${EXT[input.contentType] ?? 'bin'}`;
  const put = await ctx.storage.presignPut('documents', key, input.contentType, input.sizeBytes, 900);
  return { key, upload: put };
}

export async function confirmAudio(ctx: AppContext, req: Request, slug: string, key: string, seconds: number, actor: Actor) {
  if (!key.startsWith(`guides/${slug}/`)) throw conflict('That file does not belong to this guide');
  const head = await ctx.storage.head('documents', key);
  if (!head) throw conflict('The upload has not arrived yet');
  const g = await Guide.findOne({ slug });
  if (!g) throw notFound();
  const old = g.audioKey;
  g.audioKey = key;
  g.audioSeconds = seconds;
  await g.save();
  if (old && old !== key) await ctx.storage.delete('documents', old).catch(() => undefined);
  await audit(req, { action: 'guide.audio_set', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'guide', subjectId: slug });
  return { hasAudio: true };
}
