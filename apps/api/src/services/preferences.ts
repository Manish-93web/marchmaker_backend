import { type PreferencesInput, type PreferenceDimension } from '@marchmaker/shared';
import { AppError } from '../lib/errors';
import { Preference, Profile } from '../models/profile';
import { User } from '../models/core';

type Dim = PreferencesInput['dimensions'][number];

export async function getPreferences(userId: string) {
  const p = await Preference.findOne({ userId }).lean();
  return { version: p?.version ?? 0, dimensions: p?.dimensions ?? [] };
}

export async function putPreferences(userId: string, input: PreferencesInput, expectedVersion?: number) {
  const seen = new Set<string>();
  for (const d of input.dimensions) {
    if (seen.has(d.key)) throw new AppError(422, 'VALIDATION_ERROR', `Each preference can only appear once (${d.key})`);
    seen.add(d.key);
    if (d.range && d.range.min > d.range.max) {
      throw new AppError(422, 'VALIDATION_ERROR', `The ${d.key} range is the wrong way round`);
    }
  }
  const existing = await Preference.findOne({ userId });
  if (expectedVersion !== undefined && (existing?.version ?? 0) !== expectedVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', 'Your preferences were changed somewhere else', {
      serverVersion: existing?.version ?? 0,
    });
  }
  const updated = await Preference.findOneAndUpdate(
    { userId },
    { $set: { dimensions: input.dimensions }, $inc: { version: 1 } },
    { upsert: true, new: true },
  );
  return { version: updated.version, dimensions: updated.dimensions };
}

/** Where each preference dimension lives on a profile document. Reused by matching in Phase 8. */
export const FIELD_PATHS: Partial<Record<PreferenceDimension, string>> = {
  height: 'data.basics.heightCm',
  religion: 'data.background.religion',
  community: 'data.background.community',
  mother_tongue: 'data.background.motherTongue',
  education: 'data.education_career.highestEducation',
  profession: 'data.education_career.profession',
  diet: 'data.lifestyle.diet',
  smoking: 'data.lifestyle.smoking',
  drinking: 'data.lifestyle.drinking',
  marital_status: 'data.basics.maritalStatus',
  kids: 'data.values.wantsKids',
  family_setup: 'data.family.familyType',
  marriage_timeline: 'data.values.marriageTimeline',
};

/** Builds a Mongo filter from must-have dimensions. Income is encrypted and cannot be queried. */
export function mustHaveFilter(dims: readonly Dim[], now = new Date()): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const d of dims) {
    if (d.type !== 'must') continue;
    if (d.key === 'age' && d.range) {
      const year = now.getUTCFullYear();
      filter.birthYear = { $gte: year - d.range.max, $lte: year - d.range.min };
      continue;
    }
    if (d.key === 'location' && d.values.length) {
      filter.$or = [
        { 'data.background.city': { $in: d.values } },
        { 'data.background.state': { $in: d.values } },
      ];
      continue;
    }
    const path = FIELD_PATHS[d.key];
    if (!path) continue;
    if (d.range) filter[path] = { $gte: d.range.min, $lte: d.range.max };
    else if (d.values.length) filter[path] = { $in: d.values };
  }
  return filter;
}

export type PoolBucket = 'very_few' | 'few' | 'some' | 'many';

/** Deliberately coarse: exact counts could reveal who is on the platform. */
export function bucketFor(count: number): PoolBucket {
  if (count < 10) return 'very_few';
  if (count < 50) return 'few';
  if (count < 200) return 'some';
  return 'many';
}

const HINTS: Record<PoolBucket, string | null> = {
  very_few:
    'Your must-haves currently match very few members. Consider making one or two of them flexible to see more introductions.',
  few: 'Your must-haves match a small group. Making one flexible could widen your options.',
  some: null,
  many: null,
};

export async function poolEstimate(userId: string) {
  const [prefs, me] = await Promise.all([Preference.findOne({ userId }).lean(), User.findById(userId).select('gender')]);
  const filter = mustHaveFilter((prefs?.dimensions ?? []) as Dim[]);
  const base: Record<string, unknown> = {
    userId: { $ne: userId },
    status: { $in: ['submitted', 'approved'] },
    ...filter,
  };
  // Default to the opposite gender for men and women; non-binary members see everyone.
  if (me?.gender === 'woman') base.gender = 'man';
  else if (me?.gender === 'man') base.gender = 'woman';

  const count = await Profile.countDocuments(base);
  const bucket = bucketFor(count);
  return { bucket, hint: HINTS[bucket], mustHaveCount: (prefs?.dimensions ?? []).filter((d) => d.type === 'must').length };
}
