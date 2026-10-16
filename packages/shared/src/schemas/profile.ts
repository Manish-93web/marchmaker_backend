import { z } from 'zod';

const short = z.string().trim().max(120);
const text = (max: number) => z.string().trim().max(max);

export const profileStepSchemas = {
  basics: z.object({
    firstName: short.min(1),
    lastName: short.optional(),
    heightCm: z.number().int().min(120).max(230).optional(),
    maritalStatus: z.enum(['never_married', 'divorced', 'widowed', 'annulled']).optional(),
    hasChildren: z.boolean().optional(),
    /** Encrypted at rest. Optional and never shown to other members unless the member shares it. */
    healthNotes: text(300).optional(),
  }),
  background: z.object({
    religion: short.optional(),
    community: short.optional(),
    motherTongue: short.optional(),
    city: short.optional(),
    state: short.optional(),
    country: short.default('India'),
    citizenship: short.optional(),
    /** Optional [lng, lat] for distance-aware matching; set when the member picks a place. */
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  }),
  education_career: z.object({
    highestEducation: short.optional(),
    institution: short.optional(),
    profession: short.optional(),
    employer: short.optional(),
    incomeBand: z.string().max(40).optional(),
  }),
  family: z.object({
    familyType: z.enum(['nuclear', 'joint', 'other']).optional(),
    fatherOccupation: short.optional(),
    motherOccupation: short.optional(),
    siblings: z.number().int().min(0).max(15).optional(),
    familyValues: z.enum(['traditional', 'moderate', 'liberal']).optional(),
  }),
  lifestyle: z.object({
    diet: z.enum(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain']).optional(),
    smoking: z.enum(['never', 'occasionally', 'regularly']).optional(),
    drinking: z.enum(['never', 'occasionally', 'regularly']).optional(),
    fitness: z.enum(['rarely', 'sometimes', 'often', 'daily']).optional(),
  }),
  values: z.object({
    marriageTimeline: z.enum(['within_1_year', '1_2_years', '2_3_years', 'flexible']).optional(),
    wantsKids: z.enum(['yes', 'no', 'open']).optional(),
    settleCity: short.optional(),
    livingWithFamily: z.enum(['yes', 'no', 'open']).optional(),
    careerAfterMarriage: z.enum(['continue', 'pause', 'flexible']).optional(),
  }),
  about: z.object({
    bio: text(1000).optional(),
    prompts: z
      .array(z.object({ promptId: z.string().max(40), answer: text(400) }))
      .max(5)
      .default([]),
  }),
  photos: z.object({}).default({}),
} as const;

export type ProfileStepKey = keyof typeof profileStepSchemas;

/** Fields a member must fill before a step counts as complete (and before submitting). */
export const REQUIRED_FIELDS: Record<ProfileStepKey, readonly string[]> = {
  basics: ['firstName', 'heightCm', 'maritalStatus'],
  background: ['religion', 'motherTongue', 'city', 'state'],
  education_career: ['highestEducation', 'profession'],
  family: ['familyType'],
  lifestyle: ['diet', 'smoking', 'drinking'],
  values: ['marriageTimeline', 'wantsKids', 'livingWithFamily'],
  about: ['bio'],
  photos: [],
};

export const BIO_MIN_LENGTH = 50;

/** `photoCount` is the number of confirmed photos; the photos step is complete with at least one. */
export function isStepComplete(step: ProfileStepKey, data: Record<string, unknown> | undefined, photoCount = 0): boolean {
  if (step === 'photos') return photoCount >= 1;
  const d = data ?? {};
  const filled = REQUIRED_FIELDS[step].every((k) => {
    const v = d[k];
    if (typeof v === 'string') return v.trim().length > 0;
    return v !== undefined && v !== null;
  });
  if (!filled) return false;
  if (step === 'about') return String(d.bio ?? '').trim().length >= BIO_MIN_LENGTH;
  return true;
}

export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export const photoUploadRequestSchema = z.object({
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1024).max(PHOTO_MAX_BYTES),
});
export const photoOrderSchema = z.object({ order: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(6) });
