import type { Request } from 'express';
import { assignVariant, type ExperimentInput, type Role } from '@marchmaker/shared';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { Experiment } from '../models/growth';

interface Actor {
  userId: string;
  roles: Role[];
}

/**
 * Variants for one visitor or member. Assignment is a pure function of the experiment key and
 * the subject id, so nothing is stored per person and the same person always sees the same thing.
 */
export async function assignmentsFor(subjectId: string) {
  const live = await Experiment.find({ enabled: true }).lean();
  const out: Record<string, string> = {};
  for (const e of live) {
    const v = assignVariant(e.key, subjectId, e.variants.map((x) => ({ name: x.name ?? '', weight: x.weight ?? 0 })));
    if (v) out[e.key] = v;
  }
  return out;
}

const present = (e: { key: string; description?: string | null; enabled: boolean; variants: { name?: string | null; weight?: number | null }[]; updatedAt: Date }) => ({
  key: e.key,
  description: e.description ?? '',
  enabled: e.enabled,
  variants: e.variants.map((v) => ({ name: v.name ?? '', weight: v.weight ?? 0 })),
  updatedAt: e.updatedAt,
});

export async function adminList() {
  const rows = await Experiment.find().sort({ key: 1 }).lean();
  return { items: rows.map(present) };
}

export async function upsert(req: Request, input: ExperimentInput, actor: Actor) {
  const before = await Experiment.findOne({ key: input.key }).lean();
  const e = await Experiment.findOneAndUpdate(
    { key: input.key },
    { $set: { description: input.description, enabled: input.enabled, variants: input.variants, updatedBy: actor.userId } },
    { upsert: true, returnDocument: 'after' },
  );
  await audit(req, {
    action: before ? 'experiment.updated' : 'experiment.created',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'experiment',
    subjectId: input.key,
    before: before ? present(before) : undefined,
    after: input,
  });
  return present(e);
}

export async function remove(req: Request, key: string, actor: Actor) {
  const r = await Experiment.deleteOne({ key });
  if (!r.deletedCount) throw notFound();
  await audit(req, { action: 'experiment.deleted', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'experiment', subjectId: key });
  return { deleted: true };
}
