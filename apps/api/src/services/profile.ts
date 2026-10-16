import {
  journeyMachine,
  isStepComplete,
  PROFILE_STEPS,
  profileStepSchemas,
  trackerFor,
  type JourneyState,
  type ProfileStep,
  type ProfileStepKey,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { emit, logTransition } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { Photo, Profile } from '../models/profile';
import { User } from '../models/core';

type StepData = Record<string, unknown>;
type ProfileDoc = NonNullable<Awaited<ReturnType<typeof Profile.findOne>>>;

const EDITABLE: readonly string[] = ['draft', 'changes_requested'];

const LABELS: Record<ProfileStep, string> = {
  basics: 'Basics',
  background: 'Background',
  education_career: 'Education and career',
  family: 'Family',
  lifestyle: 'Lifestyle',
  values: 'Values and life plans',
  about: 'About you',
  photos: 'Photos',
};

function dataOf(profile: ProfileDoc | null): Record<string, StepData> {
  return ((profile?.data ?? {}) as Record<string, StepData>) ?? {};
}

async function confirmedPhotoCount(userId: string): Promise<number> {
  return Photo.countDocuments({ userId, status: { $in: ['pending', 'approved'] } });
}

async function ensureProfile(userId: string): Promise<ProfileDoc> {
  const existing = await Profile.findOne({ userId });
  if (existing) return existing;
  const user = await User.findById(userId).select('gender dobYear');
  if (!user) throw notFound();
  try {
    return await Profile.create({ userId, gender: user.gender, birthYear: user.dobYear });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await Profile.findOne({ userId });
      if (again) return again;
    }
    throw err;
  }
}

function completion(profile: ProfileDoc, photoCount: number): Record<ProfileStep, boolean> {
  const d = dataOf(profile);
  const out = {} as Record<ProfileStep, boolean>;
  for (const step of PROFILE_STEPS) out[step] = isStepComplete(step, d[step], photoCount);
  return out;
}

/** Returns the member's own profile with sensitive fields decrypted back into their steps. */
export function presentProfile(ctx: AppContext, profile: ProfileDoc, photoCount: number) {
  const data = structuredClone(dataOf(profile));
  if (profile.sensitive?.incomeBandEnc) {
    data.education_career = { ...data.education_career, incomeBand: ctx.crypto.decrypt(profile.sensitive.incomeBandEnc) };
  }
  if (profile.sensitive?.healthNotesEnc) {
    data.basics = { ...data.basics, healthNotes: ctx.crypto.decrypt(profile.sensitive.healthNotesEnc) };
  }
  const steps = completion(profile, photoCount);
  return {
    version: profile.version,
    status: profile.status,
    currentStep: profile.currentStep,
    data,
    steps,
    reviewNotes: profile.reviewNotes ?? [],
    submittedAt: profile.submittedAt ?? null,
  };
}

export async function getProfile(ctx: AppContext, userId: string) {
  const profile = await ensureProfile(userId);
  return presentProfile(ctx, profile, await confirmedPhotoCount(userId));
}

/** Resume point: the first incomplete step, or the review step when everything is done. */
function firstIncomplete(steps: Record<ProfileStep, boolean>): ProfileStep | 'review' {
  return PROFILE_STEPS.find((s) => !steps[s]) ?? 'review';
}

export async function saveStep(
  ctx: AppContext,
  userId: string,
  step: ProfileStep,
  patch: unknown,
  expectedVersion: number,
) {
  const schema = profileStepSchemas[step as ProfileStepKey];
  if (!schema) throw notFound('Unknown step');
  // Autosave sends partial forms, so only the fields present are validated.
  // `null` means "clear this field"; everything else is validated as a partial form.
  const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const clears = Object.keys(raw).filter((k) => raw[k] === null);
  const rest = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const parsed: StepData = (schema as unknown as { partial: () => { parse: (v: unknown) => StepData } })
    .partial()
    .parse(rest);
  for (const k of clears) parsed[k] = null;

  const profile = await ensureProfile(userId);
  if (!EDITABLE.includes(profile.status)) {
    throw new AppError(
      409,
      'PROFILE_LOCKED',
      profile.status === 'submitted'
        ? 'Your profile is being reviewed. You can edit it again if we ask for changes.'
        : 'Your profile has been approved. Contact support to change it.',
    );
  }
  if (profile.version !== expectedVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', 'This profile was changed somewhere else', {
      serverVersion: profile.version,
      serverData: presentProfile(ctx, profile, await confirmedPhotoCount(userId)).data[step] ?? {},
    });
  }

  const current = { ...(dataOf(profile)[step] ?? {}) };
  const set: Record<string, unknown> = {};
  const merged: StepData = { ...current };

  for (const [k, v] of Object.entries(parsed)) {
    if (step === 'education_career' && k === 'incomeBand') {
      set['sensitive.incomeBandEnc'] = v ? ctx.crypto.encrypt(String(v)) : undefined;
      continue;
    }
    if (step === 'basics' && k === 'healthNotes') {
      set['sensitive.healthNotesEnc'] = v ? ctx.crypto.encrypt(String(v)) : undefined;
      continue;
    }
    if (step === 'background' && k === 'coordinates' && Array.isArray(v)) {
      set.geo = { type: 'Point', coordinates: v };
    }
    if (v === undefined || v === null || v === '') delete merged[k];
    else merged[k] = v;
  }

  const photoCount = await confirmedPhotoCount(userId);
  const nextData = { ...dataOf(profile), [step]: merged };
  const completed = PROFILE_STEPS.filter((s) => isStepComplete(s, nextData[s], photoCount));

  // The version filter makes concurrent writers race safely: exactly one wins.
  const updated = await Profile.findOneAndUpdate(
    { _id: profile._id, version: expectedVersion },
    {
      $set: { [`data.${step}`]: merged, completedSteps: completed, currentStep: step, ...set },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    const latest = await Profile.findById(profile._id);
    throw new AppError(409, 'VERSION_CONFLICT', 'This profile was changed somewhere else', {
      serverVersion: latest?.version,
      serverData: latest ? (presentProfile(ctx, latest, photoCount).data[step] ?? {}) : {},
    });
  }

  await advanceJourney(userId, 'profile_in_progress');
  return presentProfile(ctx, updated, photoCount);
}

async function advanceJourney(userId: string, to: JourneyState) {
  const user = await User.findById(userId).select('journeyState');
  if (!user) return;
  const from = user.journeyState as JourneyState;
  if (from === to || !journeyMachine.canTransition(from, to)) return;
  await User.updateOne({ _id: userId, journeyState: from }, { $set: { journeyState: to } });
  await logTransition('user_journey', userId, from, to, userId);
}

export async function submitProfile(ctx: AppContext, userId: string) {
  const [profile, user] = await Promise.all([ensureProfile(userId), User.findById(userId)]);
  if (!user) throw notFound();
  if (!EDITABLE.includes(profile.status)) throw conflict('Your profile has already been submitted');
  if (!user.emailVerifiedAt && !user.phoneVerifiedAt) {
    throw badRequest('Please confirm your email or phone before submitting your profile');
  }
  const photoCount = await confirmedPhotoCount(userId);
  const steps = completion(profile, photoCount);
  const missing = PROFILE_STEPS.filter((s) => !steps[s]);
  if (missing.length) {
    throw new AppError(422, 'PROFILE_INCOMPLETE', 'A few details are still needed', {
      missing: missing.map((s) => ({ step: s, label: LABELS[s] })),
    });
  }

  // Move into progress first if the member never saved through the normal flow.
  if (user.journeyState === 'email_verified') await advanceJourney(userId, 'profile_in_progress');
  await advanceJourney(userId, 'profile_submitted');

  profile.status = 'submitted';
  profile.submittedAt = new Date();
  profile.version += 1;
  await profile.save();
  await emit('profile.submitted', { userId });
  return presentProfile(ctx, profile, photoCount);
}

export async function journeySummary(userId: string) {
  const [profile, user] = await Promise.all([ensureProfile(userId), User.findById(userId)]);
  if (!user) throw notFound();
  const photoCount = await confirmedPhotoCount(userId);
  const steps = completion(profile, photoCount);
  const state = user.journeyState as JourneyState;
  return {
    state,
    tracker: trackerFor(state),
    profileStatus: profile.status,
    resumeAt: firstIncomplete(steps),
    steps: PROFILE_STEPS.map((s) => ({ key: s, label: LABELS[s], complete: steps[s] })),
    // A friendly checklist, not a score.
    checklist: PROFILE_STEPS.map((s) => ({ key: s, label: LABELS[s], done: steps[s] })),
    reviewNotes: profile.reviewNotes ?? [],
  };
}
