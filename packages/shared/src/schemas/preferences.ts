import { z } from 'zod';

export const PREFERENCE_DIMENSIONS = [
  'age',
  'height',
  'location',
  'religion',
  'community',
  'mother_tongue',
  'education',
  'profession',
  'income',
  'diet',
  'smoking',
  'drinking',
  'marital_status',
  'kids',
  'family_setup',
  'marriage_timeline',
] as const;
export type PreferenceDimension = (typeof PREFERENCE_DIMENSIONS)[number];

export const preferenceItemSchema = z.object({
  key: z.enum(PREFERENCE_DIMENSIONS),
  values: z.array(z.string().max(60)).max(30).default([]),
  range: z.object({ min: z.number(), max: z.number() }).optional(),
  type: z.enum(['must', 'flexible']),
  importance: z.number().int().min(1).max(3).default(2),
});
export const preferencesSchema = z.object({ dimensions: z.array(preferenceItemSchema).max(40) });
export type PreferencesInput = z.infer<typeof preferencesSchema>;
